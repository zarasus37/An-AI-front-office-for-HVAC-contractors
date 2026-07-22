/**
 * Layer 4–2 Integration Tests
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  registerThermostat,
  getCustomerByThermostat,
  setThermostatConsent,
  _clearRegistry,
  seedDevRegistry,
} from '../src/iot/customer-registry.js';

import {
  CONSENT_TYPES,
  consentStore,
} from '../src/compliance/consent-store.js';

import {
  enqueue as qEnqueue,
  _clearAll as clearQueue,
} from '../src/queue/store.js';

import {
  _clearAll as clearSessions,
  getSession,
  pushMessage,
} from '../src/conversation/session.js';

import { ProactiveLeadGenerator } from '../src/iot/thermostat.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeShortCyclePayload(serial = 'SIM001') {
  return {
    event_type:         'runtime',
    thermostat_serial:   serial,
    runtime_report: {
      thermostat_name: 'Thermostat ' + serial,
      columns: ['date','hour','heatPump1','heatPump2','auxHeat1','auxHeat2','humidity','insideTemperature','outsideTemperature','setpoint'],
      rows: [
        ['2024-07-14',14,0,0,0,0,55,76,95,76],
        ['2024-07-14',15,0,0,0,0,55,76,96,76],
        ['2024-07-14',16,5,0,0,0,55,76,97,76],
        ['2024-07-14',17,15,0,0,0,55,76,97,76],
        ['2024-07-14',18,25,0,0,0,55,76,96,76],
        ['2024-07-14',19,30,0,0,0,55,76,95,76],
        ['2024-07-14',20,25,0,0,0,55,76,94,76],
        ['2024-07-14',21,15,0,0,0,55,76,93,76],
      ],
    },
  };
}

function mockReq(overrides = {}) {
  return {
    body: {
      event_type:         'runtime',
      thermostat_serial:   'SIM001',
      ...overrides,
    },
    header: (name) => {
      if (name === 'x-ecobee-signature') return 'test-signature';
      return '';
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(n) { this.statusCode = n; return this; },
    json(d)   { this.body = d; return this; },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('IoT Customer Registry', () => {

  beforeEach(() => { _clearRegistry(); clearQueue(); clearSessions(); });

  test('registerThermostat + getCustomerByThermostat', () => {
    registerThermostat({ thermostat_serial: 'SN001', customer_id: 'cust-1', phone: '+15551001001', name: 'Test', address: '123 Main', zip: '78596' });
    const cust = getCustomerByThermostat('SN001');
    assert.strictEqual(cust.customer_id, 'cust-1');
    assert.strictEqual(cust.phone, '+15551001001');
  });

  test('setThermostatConsent grants THERMOSTAT_TELEMETRY consent', () => {
    setThermostatConsent('cust-1', true);
    assert.ok(consentStore.hasConsent('cust-1', { consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY }));
  });

  test('getCustomerByThermostat returns undefined for unknown serial', () => {
    assert.strictEqual(getCustomerByThermostat('UNKNOWN'), undefined);
  });

  test('seedDevRegistry registers 3 known devices', () => {
    seedDevRegistry();
    const sim1 = getCustomerByThermostat('SIM001');
    const sim3 = getCustomerByThermostat('SIM003');
    assert.ok(sim1);
    assert.ok(sim3);
    assert.strictEqual(consentStore.hasConsent(sim3.customer_id, { consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY }), false);
  });
});

describe('Ecobee Webhook', () => {

  beforeEach(() => {
    _clearRegistry();
    clearQueue();
    clearSessions();
    seedDevRegistry();
  });

  test('IOT_ENABLED != true: returns iot_disabled', async () => {
    const bakE = process.env.IOT_ENABLED;
    const bakV = process.env.ECOBEE_VERIFY_SIGNATURE;
    process.env.IOT_ENABLED = 'false';
    process.env.ECOBEE_VERIFY_SIGNATURE = 'false';

    const { handleEcobeeWebhook } = await import('../src/iot/webhook.js');
    const res = mockRes();
    await handleEcobeeWebhook(mockReq({ event_type: 'runtime', thermostat_serial: 'SIM001' }), res, { logger: () => {} });

    process.env.IOT_ENABLED = bakE;
    process.env.ECOBEE_VERIFY_SIGNATURE = bakV;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.processed, false);
    assert.strictEqual(res.body.reason, 'iot_disabled');
  });

  test('unknown serial: returns no_customer_mapping', async () => {
    const bakE = process.env.IOT_ENABLED;
    const bakV = process.env.ECOBEE_VERIFY_SIGNATURE;
    process.env.IOT_ENABLED = 'true';
    process.env.ECOBEE_VERIFY_SIGNATURE = 'false';

    const { handleEcobeeWebhook } = await import('../src/iot/webhook.js');
    const res = mockRes();
    await handleEcobeeWebhook(mockReq({ event_type: 'runtime', thermostat_serial: 'BAD' }), res, { logger: () => {} });

    process.env.IOT_ENABLED = bakE;
    process.env.ECOBEE_VERIFY_SIGNATURE = bakV;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.reason, 'no_customer_mapping');
  });

  test('SIM003 (no consent): returns no_consent', async () => {
    const bakE = process.env.IOT_ENABLED;
    const bakV = process.env.ECOBEE_VERIFY_SIGNATURE;
    process.env.IOT_ENABLED = 'true';
    process.env.ECOBEE_VERIFY_SIGNATURE = 'false';

    const { handleEcobeeWebhook } = await import('../src/iot/webhook.js');
    const res = mockRes();
    await handleEcobeeWebhook(mockReq({ event_type: 'runtime', thermostat_serial: 'SIM003' }), res, { logger: () => {} });

    process.env.IOT_ENABLED = bakE;
    process.env.ECOBEE_VERIFY_SIGNATURE = bakV;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.reason, 'no_consent');
  });

  test('SIM001 + THERMOSTAT_TELEMETRY consent: enqueues IoT lead + pushes session message', async () => {
    const bakE = process.env.IOT_ENABLED;
    const bakV = process.env.ECOBEE_VERIFY_SIGNATURE;
    const bakO = process.env.OUTBOUND_ENABLED;
    process.env.IOT_ENABLED = 'true';
    process.env.ECOBEE_VERIFY_SIGNATURE = 'false';
    process.env.OUTBOUND_ENABLED = 'false';

    consentStore.grant({ customerId: 'cust-dev-001', consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY, source: 'test' });

    const { handleEcobeeWebhook } = await import('../src/iot/webhook.js');
    const res     = mockRes();
    const pushed  = [];
    const mockQueue = { enqueue: () => 'mock-id', updateEntry: () => {}, getEntry: () => null };

    await handleEcobeeWebhook(
      mockReq(makeShortCyclePayload('SIM001')),
      res,
      {
        fsmAdapter: null,
        queueStore: mockQueue,
        sessionStore: {
          getSession:       (phone)  => getSession(phone, 'default'),
          pushMessage:      (phone, role, content) => pushed.push({ phone, role, content }),
          setClassification: () => {},
        },
        logger: () => {},
      },
    );

    process.env.IOT_ENABLED = bakE;
    process.env.ECOBEE_VERIFY_SIGNATURE = bakV;
    process.env.OUTBOUND_ENABLED = bakO;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.processed, true);
    assert.ok(res.body.signals.length > 0);
    assert.strictEqual(res.body.signals[0].signal, 'short_cycling');
    assert.ok(pushed.some(m => m.role === 'system' && m.content.includes('IoT Alert')));
  });

  test('OUTBOUND_ENABLED=true: enqueues proactive outbound SMS', async () => {
    const bakE = process.env.IOT_ENABLED;
    const bakV = process.env.ECOBEE_VERIFY_SIGNATURE;
    const bakO = process.env.OUTBOUND_ENABLED;
    process.env.IOT_ENABLED = 'true';
    process.env.ECOBEE_VERIFY_SIGNATURE = 'false';
    process.env.OUTBOUND_ENABLED = 'true';

    consentStore.grant({ customerId: 'cust-dev-001', consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY, source: 'test' });

    const { handleEcobeeWebhook } = await import('../src/iot/webhook.js');
    const res      = mockRes();
    const outbound = [];
    const mockQueue = {
      enqueue: (entry) => { if (entry.direction === 'outbound') outbound.push(entry); return 'mock-id'; },
      updateEntry: () => {},
      getEntry:    () => null,
    };

    await handleEcobeeWebhook(
      mockReq(makeShortCyclePayload('SIM001')),
      res,
      { fsmAdapter: null, queueStore: mockQueue, sessionStore: {}, logger: () => {} },
    );

    process.env.IOT_ENABLED = bakE;
    process.env.ECOBEE_VERIFY_SIGNATURE = bakV;
    process.env.OUTBOUND_ENABLED = bakO;

    assert.strictEqual(outbound.length, 1);
    assert.strictEqual(outbound[0].channel,    'sms');
    assert.strictEqual(outbound[0].direction,  'outbound');
    assert.strictEqual(outbound[0].status,     'pending');
    assert.strictEqual(outbound[0].priority,    'high');
    assert.strictEqual(outbound[0].caller_phone, '+15551001001');
  });
});
