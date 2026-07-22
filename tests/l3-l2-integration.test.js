/**
 * Layer 3–2 Integration Tests
 *
 * Tests:
 *   1. Pricebook lookup by service hint → returns correct entry
 *   2. Quote request → price gate fires → PRICE_FALLBACK without pricebook
 *   3. Quote request → pricebook match → price included in response
 *   4. FSM upsertCustomer → createJob push flow
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// ── Imports ─────────────────────────────────────────────────────────────────────

import { gateResponse } from '../src/conversation/price-gate.js';
import { ruleBasedClassify } from '../src/conversation/classifier.js';
import { lookupPricebook } from '../src/fsm/router.js';
import { pushLeadToFsm } from '../src/fsm/router.js';
import { enqueue, updateEntry, _clearAll as clearQueue } from '../src/queue/store.js';
import { _clearAll as clearSessions } from '../src/conversation/session.js';
import { MockFsmAdapter } from '../src/fsm/mock.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make a minimal queue entry for FSM push tests */
function makeLeadEntry(overrides = {}) {
  return enqueue({
    channel:         'sms',
    tenant_id:        'default',
    raw_input:        'My AC is making a loud noise',
    caller_phone:     '+15551001001',
    service_address: '123 Main St, Weslaco TX 78596',
    contact_name:    'Test Customer',
    ...overrides,
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Layer 3–2 — FSM Pricebook Wiring', () => {

  beforeEach(() => {
    clearQueue();
    clearSessions();
  });

  // ── Pricebook Lookup ──────────────────────────────────────────────────────────

  test('lookupPricebook("AC repair") returns AC Repair entry with price', async () => {
    const entry = await lookupPricebook('AC repair', null);
    assert.ok(entry, 'Should find a matching pricebook entry');
    assert.strictEqual(entry.service_name, 'AC Repair');
    assert.strictEqual(entry.price, 89);
    assert.strictEqual(entry.job_type, 'repair');
  });

  test('lookupPricebook("annual maintenance") returns maintenance entry', async () => {
    const entry = await lookupPricebook('annual maintenance', null);
    assert.ok(entry);
    assert.strictEqual(entry.job_type, 'maintenance');
    assert.strictEqual(entry.price, 149);
  });

  test('lookupPricebook("heat pump tune up") returns Heat Pump Tune-Up entry', async () => {
    const entry = await lookupPricebook('heat pump tune up', null);
    assert.ok(entry);
    assert.strictEqual(entry.service_name, 'Heat Pump Tune-Up');
    assert.strictEqual(entry.price, 85);
  });

  test('lookupPricebook("emergency service") returns Emergency Service entry', async () => {
    const entry = await lookupPricebook('emergency service', null);
    assert.ok(entry);
    assert.strictEqual(entry.job_type, 'repair');
    assert.strictEqual(entry.price, 150);
  });

  test('lookupPricebook with single stop-word returns null', async () => {
    const entry = await lookupPricebook('my ac', null);
    // "my" is a stop-word, "ac" alone scores below threshold
    assert.strictEqual(entry, null);
  });

  // ── Price Gate ───────────────────────────────────────────────────────────────

  test('gateResponse: customer asks price, no pricebook → PRICE_FALLBACK', () => {
    const text   = 'The repair will cost about $120';
    const msg    = 'How much does a repair cost?';
    const result = gateResponse(text, msg, null);
    // PRICE_FALLBACK: 'A technician will provide an exact quote on-site after diagnosing the issue.'
    assert.ok(result.includes('exact quote'));
  });

  test('gateResponse: pricebook match provided → price mention allowed', () => {
    const text   = 'Your AC Repair will be $89';
    const msg    = 'How much is an AC repair?';
    const match  = { service_name: 'AC Repair', price: 89, job_type: 'repair' };
    const result = gateResponse(text, msg, match);
    assert.strictEqual(result, text); // no redaction
  });

  test('gateResponse: pricebook mismatch → redacts unauthorized price', () => {
    const text   = 'The repair will be $200'; // mentions $200 but confirmed price is $89
    const msg    = 'How much is an AC repair?';
    const match  = { service_name: 'AC Repair', price: 89, job_type: 'repair' };
    const result = gateResponse(text, msg, match);
    assert.ok(result.includes('[REDACTED]'));
  });

  test('gateResponse: no price mentioned → passes through unchanged', () => {
    const text   = 'A technician will be out to take a look at your system.';
    const msg    = 'My AC is making noise';
    const match  = { service_name: 'AC Repair', price: 89, job_type: 'repair' };
    const result = gateResponse(text, msg, match);
    assert.strictEqual(result, text);
  });

  // ── Classifier → Pricebook Intent ──────────────────────────────────────────

  test('ruleBasedClassify("how much is an AC repair?") → quote_request intent', () => {
    const result = ruleBasedClassify('How much is an AC repair?');
    assert.strictEqual(result.intent, 'quote_request');
    assert.strictEqual(result.job_type, 'repair');
  });

  test('ruleBasedClassify("can you fix my furnace") → schedule_service intent', () => {
    const result = ruleBasedClassify('Can you fix my furnace?');
    assert.strictEqual(result.intent, 'schedule_service');
  });

  // ── FSM Push Lead ────────────────────────────────────────────────────────────

  test('pushLeadToFsm → upserts customer + creates job', async () => {
    const entry = makeLeadEntry();
    const { customer, job } = await pushLeadToFsm(entry);

    assert.ok(customer.fsm_id, 'Should return a customer with fsm_id');
    assert.ok(job.fsm_id, 'Should return a job with fsm_id');
    assert.strictEqual(job.status, 'queued');
    assert.ok(job.fsm_id.startsWith('mock_job_'));
  });

  test('pushLeadToFsm with minimal entry → creates job with defaults', async () => {
    const minimal = enqueue({
      channel:         'sms',
      tenant_id:        'default',
      raw_input:        'Test message',
      caller_phone:    '+15552002000',
    });
    const { customer, job } = await pushLeadToFsm(minimal);
    assert.ok(job.fsm_id);
    assert.strictEqual(job.intent, 'other');
    assert.strictEqual(job.urgency, 'routine');
  });
});
