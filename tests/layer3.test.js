/**
 * Layer 3 — FSM Integration Tests
 * Tests: FsmAdapter contract, MockFsmAdapter, FSM router, lead push flow
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FsmAdapter, FsmError } from '../src/fsm/adapter.js';
import { MockFsmAdapter }      from '../src/fsm/mock.js';
import { JobberAdapter }        from '../src/fsm/jobber.js';

// ── FsmAdapter contract ──────────────────────────────────────────────────────────

describe('FsmAdapter — base contract', () => {
  test('FsmError has correct properties', () => {
    const err = new FsmError('test message', 'auth', 'jobber', new Error('cause'));
    assert.equal(err.message, 'test message');
    assert.equal(err.type, 'auth');
    assert.equal(err.fsm, 'jobber');
    assert.ok(err.cause instanceof Error);
  });

  test('FsmError types are recognized', () => {
    const types = ['auth', 'network', 'validation', 'not_found', 'unknown'];
    types.forEach(t => {
      const err = new FsmError('msg', t, 'mock');
      assert.equal(err.type, t);
    });
  });
});

// ── MockFsmAdapter ───────────────────────────────────────────────────────────────

describe('MockFsmAdapter', () => {
  /** @type {MockFsmAdapter} */
  let adapter;

  beforeEach(() => {
    adapter = new MockFsmAdapter();
    adapter.initialize({ resetState: true });
  });

  test('initialize returns without error', async () => {
    await adapter.initialize(); // no-op
    assert.equal(adapter.name, 'mock');
  });

  test('upsertCustomer creates new customer', async () => {
    const customer = await adapter.upsertCustomer({
      phone:   '+15551234567',
      email:   'test@example.com',
      name:    'John Doe',
      address: '123 Main St',
    });
    assert.ok(customer.fsm_id.startsWith('mock_cust_'));
    assert.equal(customer.phone, '+15551234567');
    assert.equal(customer.email, 'test@example.com');
    assert.equal(customer.name, 'John Doe');
    assert.equal(customer.address, '123 Main St');
  });

  test('upsertCustomer updates existing customer', async () => {
    const first = await adapter.upsertCustomer({ phone: '+15551234567', name: 'John' });
    const second = await adapter.upsertCustomer({ phone: '+15551234567', name: 'John Updated' });
    assert.equal(first.fsm_id, second.fsm_id);
    assert.equal(second.name, 'John Updated');
  });

  test('findCustomer finds by phone', async () => {
    await adapter.upsertCustomer({ phone: '+15551234567', name: 'Find Me' });
    const found = await adapter.findCustomer('+15551234567', null);
    assert.ok(found);
    assert.equal(found.name, 'Find Me');
  });

  test('findCustomer finds by email', async () => {
    await adapter.upsertCustomer({ phone: '+15551234567', email: 'find@example.com', name: 'Find' });
    const found = await adapter.findCustomer(null, 'find@example.com');
    assert.ok(found);
    assert.equal(found.name, 'Find');
  });

  test('findCustomer returns null for unknown', async () => {
    const found = await adapter.findCustomer('+15550000000', null);
    assert.equal(found, null);
  });

  test('createJob returns job with fsm_id and queued status', async () => {
    const customer = await adapter.upsertCustomer({ phone: '+15551234567' });
    const job = await adapter.createJob({
      customerId:  customer.fsm_id,
      phone:      '+15551234567',
      address:    '123 Main St',
      description: 'AC not working',
      intent:     'schedule_service',
      urgency:    'urgent',
    });
    assert.ok(job.fsm_id.startsWith('mock_job_'));
    assert.equal(job.status, 'queued');
  });

  test('createJob accepts all urgency levels', async () => {
    const customer = await adapter.upsertCustomer({ phone: '+15551234567' });
    for (const urgency of ['emergency', 'urgent', 'routine', 'low']) {
      const job = await adapter.createJob({
        customerId: customer.fsm_id, phone: '+15551234567',
        address: '123 Main St', description: 'test', intent: 'other', urgency,
      });
      assert.equal(job.status, 'queued', `urgency=${urgency} should be queued`);
    }
  });

  test('getPricebookEntry fuzzy-matches service name', async () => {
    const entry = await adapter.getPricebookEntry('my ac is broken', 'repair');
    assert.ok(entry);
    assert.ok(['AC Repair', 'Refrigerant Recharge'].includes(entry.service_name), `got ${entry.service_name}`);
    assert.equal(entry.job_type, 'repair');
    assert.ok(entry.price > 0);
  });

  test('getPricebookEntry falls back to jobType', async () => {
    const entry = await adapter.getPricebookEntry(null, 'maintenance');
    assert.ok(entry);
    assert.equal(entry.job_type, 'maintenance');
  });

  test('getPricebookEntry returns null for unknown', async () => {
    const entry = await adapter.getPricebookEntry('xyz not a service', null);
    assert.equal(entry, null);
  });

  test('getMembership returns null for non-member', async () => {
    const customer = await adapter.upsertCustomer({ phone: '+15551234567' });
    const membership = await adapter.getMembership(customer.fsm_id);
    assert.equal(membership, null);
  });

  test('getMembership returns plan for member', async () => {
    adapter.seedCustomerWithMembership({
      fsm_id: 'cust_123', phone: '+15551234567', email: null, name: null, address: null,
    }, 'Gold Plan');
    const membership = await adapter.getMembership('cust_123');
    assert.ok(membership);
    assert.equal(membership.plan, 'Gold Plan');
    assert.ok(new Date(membership.expiresAt) > new Date());
  });
});

// ── JobberAdapter — initialization ────────────────────────────────────────────────

describe('JobberAdapter — initialization', () => {

  test('initialize throws if no credentials', async () => {
    // Save and clear env
    const savedToken      = process.env.JOBBER_ACCESS_TOKEN;
    const savedRefresh    = process.env.JOBBER_REFRESH_TOKEN;
    const savedClientId   = process.env.JOBBER_CLIENT_ID;
    const savedClientSec  = process.env.JOBBER_CLIENT_SECRET;

    delete process.env.JOBBER_ACCESS_TOKEN;
    delete process.env.JOBBER_REFRESH_TOKEN;
    delete process.env.JOBBER_CLIENT_ID;
    delete process.env.JOBBER_CLIENT_SECRET;

    const adapter = new JobberAdapter();
    try {
      await assert.rejects(
        async () => adapter.initialize(),
        (err) => { assert.equal(err.type, 'auth'); return true; }
      );
    } finally {
      // Restore env
      if (savedToken)     process.env.JOBBER_ACCESS_TOKEN     = savedToken;
      if (savedRefresh)   process.env.JOBBER_REFRESH_TOKEN    = savedRefresh;
      if (savedClientId)  process.env.JOBBER_CLIENT_ID        = savedClientId;
      if (savedClientSec) process.env.JOBBER_CLIENT_SECRET     = savedClientSec;
    }
  });

  test('initialize succeeds with just access token (no refresh)', async () => {
    const saved = process.env.JOBBER_ACCESS_TOKEN;
    process.env.JOBBER_ACCESS_TOKEN = 'test_token_abc123';
    try {
      const adapter = new JobberAdapter();
      await adapter.initialize(); // should not throw
    } finally {
      if (saved) process.env.JOBBER_ACCESS_TOKEN = saved;
      else delete process.env.JOBBER_ACCESS_TOKEN;
    }
  });
});

// ── FSM Router ──────────────────────────────────────────────────────────────────

describe('FSM Router', () => {
  // router.js imports JobberAdapter and initializes it at module level
  // which means it reads env vars at import time.
  // Test by checking the getAdapter behavior with a mock adapter set.

  test('router exports initializeAdapters function', async () => {
    const { initializeAdapters } = await import('../src/fsm/router.js');
    assert.equal(typeof initializeAdapters, 'function');
  });

  test('initializeAdapters returns array of adapter statuses', async () => {
    const { initializeAdapters } = await import('../src/fsm/router.js');
    // Without env vars, only mock/unconfigured adapters exist
    const results = await initializeAdapters();
    assert.ok(Array.isArray(results));
    results.forEach(r => {
      assert.ok('name' in r);
      assert.ok('status' in r);
    });
  });
});

// ── Lead push integration ────────────────────────────────────────────────────────

describe('FSM lead push flow', () => {
  /** @type {MockFsmAdapter} */
  let adapter;

  beforeEach(async () => {
    adapter = new MockFsmAdapter();
    await adapter.initialize({ resetState: true });
  });

  test('full flow: upsertCustomer → createJob → job has fsm_id', async () => {
    // Simulate the pushLeadToFsm flow
    const customer = await adapter.upsertCustomer({
      phone:   '+15551234567',
      email:   'cris@example.com',
      name:    'Cris Colon',
      address: '456 Oak Lane, Weslaco TX',
    });
    assert.ok(customer.fsm_id);

    const job = await adapter.createJob({
      customerId:  customer.fsm_id,
      phone:      '+15551234567',
      address:    '456 Oak Lane, Weslaco TX',
      description: 'AC making loud noise, possible capacitor issue',
      intent:     'schedule_service',
      urgency:    'urgent',
    });
    assert.ok(job.fsm_id.startsWith('mock_job_'));
    assert.equal(job.status, 'queued');
  });

  test('pricebook lookup prevents unauthorized pricing', async () => {
    // Customer asks for AC repair price
    const entry = await adapter.getPricebookEntry('ac repair', 'repair');
    assert.ok(entry);
    assert.ok(entry.price > 0);
    // Price gate should allow this because pricebook match exists
    const { gateResponse } = await import('../src/conversation/price-gate.js');
    const result = gateResponse(
      `The repair will be $${entry.price}`,
      'how much for ac repair',
      entry
    );
    assert.ok(!result.includes('[REDACTED]'));
  });

  test('pricebook returns null for unknown service → price gate enforces fallback', async () => {
    const entry = await adapter.getPricebookEntry('quantum refrigeration', null);
    assert.equal(entry, null);

    const { gateResponse } = await import('../src/conversation/price-gate.js');
    const { PRICE_FALLBACK } = await import('../src/conversation/system-prompt.js');
    const result = gateResponse(
      'The repair will be $500',
      'how much for quantum something',
      null
    );
    assert.equal(result, PRICE_FALLBACK);
  });
});
