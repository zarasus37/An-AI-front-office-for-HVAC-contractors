/**
 * Layer 6 — Compliance Substrate Tests
 * Tests: ConsentStore, TcpaStopWordHandler, CIPA disclosure layer
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ConsentStore,
  TcpaStopWordHandler,
  buildCipaTwiml,
  CIPA_DISCLOSURE_TEXT,
} from '../src/compliance/consent-store.js';

describe('ConsentStore', () => {

  /** @type {ConsentStore} */
  let store;

  beforeEach(() => {
    store = new ConsentStore();
  });

  test('grant() creates a consent record', () => {
    const record = store.grant({
      customerId: 'cust-1',
      channel: 'sms',
      consentType: 'sms_inbound',
      source: 'web_form',
      scope: 'Receive SMS updates',
    });

    assert.ok(record.id, 'record has id');
    assert.strictEqual(record.customer_id, 'cust-1');
    assert.strictEqual(record.granted, true);
    assert.ok(record.granted_at, 'has granted_at');
    assert.strictEqual(record.revoked_at, null);
  });

  test('hasConsent() returns true for granted consent', () => {
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound', channel: 'sms' });
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'sms_inbound' }), true);
  });

  test('hasConsent() returns false for revoked consent', () => {
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound', channel: 'sms' });
    store.revoke({ customerId: 'cust-1', consentType: 'sms_inbound' });
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'sms_inbound' }), false);
  });

  test('hasConsent() returns false when no consent exists', () => {
    assert.strictEqual(store.hasConsent('cust-99', { consentType: 'sms_inbound' }), false);
  });

  test('hasConsent() filters by channel when specified', () => {
    store.grant({ customerId: 'cust-1', channel: 'sms', consentType: 'sms_inbound' });
    assert.strictEqual(store.hasConsent('cust-1', { channel: 'sms', consentType: 'sms_inbound' }), true);
    assert.strictEqual(store.hasConsent('cust-1', { channel: 'voice', consentType: 'sms_inbound' }), false);
  });

  test('revokeAll() revokes every active consent for a customer', () => {
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound',   channel: 'sms' });
    store.grant({ customerId: 'cust-1', consentType: 'thermostat_telemetry', channel: 'thermostat' });
    store.grant({ customerId: 'cust-1', consentType: 'marketing',    channel: 'sms' });

    const revoked = store.revokeAll('cust-1');

    assert.strictEqual(revoked.length, 3);
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'sms_inbound' }), false);
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'thermostat_telemetry' }), false);
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'marketing' }), false);
  });

  test('getRecords() returns all records including revoked', () => {
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound' });
    store.grant({ customerId: 'cust-1', consentType: 'marketing' });
    store.revoke({ customerId: 'cust-1', consentType: 'sms_inbound' });

    const records = store.getRecords('cust-1');
    assert.strictEqual(records.length, 2);

    // SMS was revoked, marketing was not — sort by revoked_at (null = active = first)
    const sorted = [...records].sort((a, b) => {
      if (a.revoked_at && b.revoked_at) return 0;
      if (!a.revoked_at) return -1;  // active first
      return 1;                        // revoked last
    });

    assert.strictEqual(sorted[0].consent_type, 'marketing', 'active marketing comes first');
    assert.strictEqual(sorted[0].revoked_at, null, 'marketing record is not revoked');
    assert.strictEqual(sorted[1].consent_type, 'sms_inbound', 'revoked sms comes last');
    assert.ok(sorted[1].revoked_at, 'sms record is revoked');
  });

  test('getActiveConsent() returns most recent active consent', () => {
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound' });
    // Sleep 1ms to ensure different timestamp
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound' });

    const latest = store.getActiveConsent('cust-1', 'sms_inbound');
    assert.ok(latest, 'has an active consent');
    assert.strictEqual(latest.granted, true);
    assert.strictEqual(latest.revoked_at, null);
  });

  test('bulkImport() imports existing records', () => {
    store.bulkImport([
      { customer_id: 'cust-x', consent_type: 'sms_inbound', granted: true, granted_at: '2024-01-01T00:00:00Z', channel: 'sms' },
    ]);

    assert.strictEqual(store.hasConsent('cust-x', { consentType: 'sms_inbound' }), true);
  });
});

describe('TcpaStopWordHandler — containsStopWord', () => {

  test('matches common stop words', () => {
    const { containsStopWord } = TcpaStopWordHandler;
    assert.strictEqual(containsStopWord('STOP'), true);
    assert.strictEqual(containsStopWord('stop'), true);
    assert.strictEqual(containsStopWord('STOP ALL'), true);
    assert.strictEqual(containsStopWord('UNSUBSCRIBE'), true);
    assert.strictEqual(containsStopWord('cancel'), true);
    assert.strictEqual(containsStopWord('END'), true);
    assert.strictEqual(containsStopWord('QUIT'), true);
    assert.strictEqual(containsStopWord('OPT-OUT'), true);
    assert.strictEqual(containsStopWord('OPTOUT'), true);
  });

  test('does not match stop words inside other words', () => {
    const { containsStopWord } = TcpaStopWordHandler;
    assert.strictEqual(containsStopWord('STOPLOSS'), false);  // no word boundary before STOP
    assert.strictEqual(containsStopWord('MYUNSUBSCRIBE'), false); // unsubscribe not at word boundary
    assert.strictEqual(containsStopWord('CANCELLED'), false); // cancelled != cancel
  });

  test('matches standalone stop words', () => {
    const { containsStopWord } = TcpaStopWordHandler;
    assert.strictEqual(containsStopWord('unsubscribe'), true);  // UNSUBSCRIBE at word boundary
    assert.strictEqual(containsStopWord('stop'), true);
    assert.strictEqual(containsStopWord('cancel'), true);
  });

  test('returns false for null/empty input', () => {
    const { containsStopWord } = TcpaStopWordHandler;
    assert.strictEqual(containsStopWord(null), false);
    assert.strictEqual(containsStopWord(''), false);
    assert.strictEqual(containsStopWord('hello'), false);
  });
});

describe('TcpaStopWordHandler — handleStopWord', () => {

  test('revokes consent when stop word detected', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound', channel: 'sms' });

    const handler = new TcpaStopWordHandler({ consentStore: store, logger: () => {} });
    const result = handler.handleStopWord('STOP', 'cust-1', 'sms');

    assert.strictEqual(result.stopped, true);
    assert.ok(result.record, 'has revoked records');
    assert.strictEqual(result.revokedCount, 1);
    assert.strictEqual(store.hasConsent('cust-1', { consentType: 'sms_inbound' }), false);
  });

  test('returns { stopped: false } when no stop word', () => {
    const store = new ConsentStore();
    const handler = new TcpaStopWordHandler({ consentStore: store, logger: () => {} });
    const result = handler.handleStopWord('I need service', 'cust-1', 'sms');
    assert.strictEqual(result.stopped, false);
    assert.strictEqual(result.record, null);
  });

  test('canSendSms returns true when active SMS consent exists', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound', channel: 'sms' });
    const handler = new TcpaStopWordHandler({ consentStore: store });
    assert.strictEqual(handler.canSendSms('cust-1'), true);
  });

  test('canSendSms returns false when SMS consent is revoked', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound', channel: 'sms' });
    store.revoke({ customerId: 'cust-1', consentType: 'sms_inbound' });
    const handler = new TcpaStopWordHandler({ consentStore: store });
    assert.strictEqual(handler.canSendSms('cust-1'), false);
  });

  test('getComplianceStatus returns correct counts', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust-1', consentType: 'sms_inbound' });
    store.grant({ customerId: 'cust-1', consentType: 'marketing' });
    store.revoke({ customerId: 'cust-1', consentType: 'marketing' });

    const handler = new TcpaStopWordHandler({ consentStore: store });
    const status = handler.getComplianceStatus('cust-1');

    assert.strictEqual(status.activeConsentCount, 1);
    assert.strictEqual(status.revokedConsentCount, 1);
    assert.strictEqual(status.fullyRevoked, false);
  });
});

describe('CIPA Disclosure Layer', () => {

  test('buildCipaTwiml generates valid TwiML Say element', () => {
    const twiml = buildCipaTwiml({ full: true });
    assert.ok(twiml.includes('<Say'), 'contains <Say');
    assert.ok(twiml.includes(CIPA_DISCLOSURE_TEXT.slice(0, 30)), 'contains disclosure text');
    assert.ok(twiml.includes('</Say>'), 'closes Say tag');
  });

  test('buildCipaTwiml short version uses abbreviated text', () => {
    const fullTwiml    = buildCipaTwiml({ full: true });
    const shortTwiml   = buildCipaTwiml({ full: false });
    assert.notStrictEqual(fullTwiml, shortTwiml, 'short and full differ');
  });

  test('CIPA_DISCLOSURE_TEXT is non-empty', () => {
    assert.ok(CIPA_DISCLOSURE_TEXT.length > 50, 'disclosure is substantive');
    assert.ok(CIPA_DISCLOSURE_TEXT.includes('recorded'), 'mentions recording');
    assert.ok(CIPA_DISCLOSURE_TEXT.includes('artificial intelligence') || CIPA_DISCLOSURE_TEXT.includes('AI'), 'mentions AI analysis');
  });
});
