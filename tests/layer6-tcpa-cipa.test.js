/**
 * Layer 6 — TCPA/CIPA Integration Tests
 *
 * Tests:
 *   1. TcpaStopWordHandler detects STOP and revokes all consent
 *   2. TcpaStopWordHandler allows non-stop messages through
 *   3. TCPA stop-word → returns STOP acknowledgment TwiML
 *   4. canSendOutboundSms blocks when no SMS_INBOUND consent
 *   5. canSendOutboundSms allows when consent active
 *   6. Voice inbound → CIPA disclosure TwiML played
 *   7. Voice inbound stage 2 → queue entry created
 *   8. Renewal outreach → blocked when no SMS consent
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { URL } from 'url';

// ── Imports ─────────────────────────────────────────────────────────────────────

import { ConsentStore, TcpaStopWordHandler, CONSENT_TYPES } from '../src/compliance/consent-store.js';
import { canSendOutboundSms, sendOutboundSms, TCPA_STOP_ACKNOWLEDGE } from '../src/channels/outbound.js';
import { buildCipaCompliantVoiceTwiml, buildCipaTwiml } from '../src/compliance/consent-store.js';
import { enqueue, updateEntry, _clearAll as clearQueue } from '../src/queue/store.js';
import { consentStore } from '../src/compliance/consent-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal mock Express request */
function mockReq(overrides = {}) {
  return {
    headers:    {},
    body:       {},
    ip:         '127.0.0.1',
    method:     'POST',
    path:       '/webhooks/voice',
    query:      {},
    params:     {},
    ...overrides,
    header:     (name) => overrides.headers?.[name.toLowerCase()] ?? null,
  };
}

/** Minimal mock Express response */
function mockRes() {
  const r = {
    statusCode: 200,
    body:       '',
    _headers:   {},
    status(n)   { this.statusCode = n; return this; },
    set(k, v)   { this._headers[k.toLowerCase()] = v; return this; },
    send(b)     { this.body = typeof b === 'string' ? b : JSON.stringify(b); return this; },
    json(d)     { this.body = JSON.stringify(d); return this; },
  };
  return r;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Layer 6 — TCPA/CIPA Wiring', () => {

  beforeEach(() => {
    consentStore._reset();
    clearQueue();
  });

  // ── TCPA Stop-Word Detection ───────────────────────────────────────────────

  test('TcpaStopWordHandler detects STOP and revokes all consent', () => {
    consentStore.grant({ customerId: 'cust_001', consentType: CONSENT_TYPES.SMS_INBOUND });
    consentStore.grant({ customerId: 'cust_001', consentType: CONSENT_TYPES.MARKETING });

    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });
    const result = handler.handleStopWord('STOP', 'cust_001', 'sms');

    assert.strictEqual(result.stopped, true);
    assert.ok(result.revokedCount >= 2);
    assert.strictEqual(consentStore.hasConsent('cust_001', { consentType: CONSENT_TYPES.SMS_INBOUND }), false);
  });

  test('TcpaStopWordHandler handles case-insensitive STOP', () => {
    consentStore.grant({ customerId: 'cust_002', consentType: CONSENT_TYPES.SMS_INBOUND });
    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });

    const result = handler.handleStopWord('stop', 'cust_002', 'sms');
    assert.strictEqual(result.stopped, true);
  });

  test('TcpaStopWordHandler handles STOPALL', () => {
    consentStore.grant({ customerId: 'cust_003', consentType: CONSENT_TYPES.SMS_INBOUND });
    consentStore.grant({ customerId: 'cust_003', consentType: CONSENT_TYPES.MARKETING });
    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });

    const result = handler.handleStopWord('STOPALL', 'cust_003', 'sms');
    assert.strictEqual(result.stopped, true);
    assert.strictEqual(consentStore.hasConsent('cust_003', { consentType: CONSENT_TYPES.SMS_INBOUND }), false);
  });

  test('TcpaStopWordHandler allows non-stop messages through', () => {
    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });
    const result = handler.handleStopWord('I need AC repair please', 'cust_004', 'sms');
    assert.strictEqual(result.stopped, false);
    assert.strictEqual(result.record, null);
  });

  test('TcpaStopWordHandler handles UNSUBSCRIBE', () => {
    consentStore.grant({ customerId: 'cust_005', consentType: CONSENT_TYPES.SMS_INBOUND });
    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });

    const result = handler.handleStopWord('UNSUBSCRIBE', 'cust_005', 'sms');
    assert.strictEqual(result.stopped, true);
  });

  // ── TCPA STOP Acknowledgment Text ─────────────────────────────────────────

  test('TCPA_STOP_ACKNOWLEDGE contains no marketing content', () => {
    const marketing = ['discount', 'offer', 'deal', 'click', 'buy', 'sale', 'limited'];
    for (const word of marketing) {
      assert.ok(!TCPA_STOP_ACKNOWLEDGE.toLowerCase().includes(word),
        `"${word}" should not appear in STOP acknowledgment`);
    }
  });

  // ── Outbound SMS Consent Guard ─────────────────────────────────────────────

  test('canSendOutboundSms blocks when no SMS_INBOUND consent', () => {
    // No consent granted
    const { allowed, reason } = canSendOutboundSms('cust_no_consent', '+15550001000');
    assert.strictEqual(allowed, false);
    assert.ok(reason.includes('No active SMS consent'));
  });

  test('canSendOutboundSms allows when SMS_INBOUND consent active', () => {
    consentStore.grant({ customerId: 'cust_active', consentType: CONSENT_TYPES.SMS_INBOUND });
    const { allowed, reason } = canSendOutboundSms('cust_active', '+15550002000');
    assert.strictEqual(allowed, true);
    assert.strictEqual(reason, null);
  });

  test('canSendOutboundSms allows when customerId is null (phone-only lookup)', () => {
    const { allowed } = canSendOutboundSms(null, '+15550003000');
    assert.strictEqual(allowed, true);
  });

  // ── sendOutboundSms throws TCPA error when blocked ────────────────────────

  test('sendOutboundSms throws when TCPA blocks', async () => {
    consentStore.grant({ customerId: 'cust_blocked', consentType: CONSENT_TYPES.MARKETING }); // wrong type
    consentStore.grant({ customerId: 'cust_blocked', consentType: CONSENT_TYPES.CALL_RECORDING });

    await assert.rejects(
      async () => sendOutboundSms({ to: '+15550004000', body: 'Hello!', customerId: 'cust_blocked' }),
      (err) => {
        assert.ok(err.message.includes('TCPA blocked'));
        return true;
      }
    );
  });

  // ── CIPA Disclosure ────────────────────────────────────────────────────────

  test('buildCipaTwiml returns valid TwiML with Say element', () => {
    const twiml = buildCipaTwiml({ full: true });
    assert.ok(twiml.includes('<Say'), 'Should contain <Say element');
    assert.ok(twiml.includes('recorded'), 'Should mention recording');
    assert.ok(twiml.includes('artificial intelligence'), 'Should mention AI');
  });

  test('buildCipaTwiml short form uses shorter text', () => {
    const full    = buildCipaTwiml({ full: true });
    const short   = buildCipaTwiml({ full: false });
    assert.ok(short.length < full.length, 'Short form should be shorter');
  });

  test('buildCipaCompliantVoiceTwiml with nextUrl includes Redirect', () => {
    const twiml = buildCipaCompliantVoiceTwiml({ nextUrl: 'https://example.com/voice/handler' });
    assert.ok(twiml.includes('<Say'), 'Should contain <Say element');
    assert.ok(twiml.includes('<Redirect'), 'Should contain <Redirect element');
    assert.ok(twiml.includes('https://example.com/voice/handler'), 'Should include nextUrl');
  });

  test('buildCipaCompliantVoiceTwiml without nextUrl is just disclosure', () => {
    const twiml = buildCipaCompliantVoiceTwiml({});
    assert.ok(twiml.includes('<Say'), 'Should contain <Say element');
    assert.ok(!twiml.includes('<Redirect'), 'Should not contain <Redirect without nextUrl');
  });

  // ── Voice Queue Flow ───────────────────────────────────────────────────────

  test('voice inbound enqueues entry with direction=inbound', () => {
    const entry = enqueue({
      channel:         'voice',
      direction:      'inbound',
      tenant_id:        'default',
      raw_input:        'Voice call from +15550001000',
      caller_phone:    '+15550001000',
    });
    assert.strictEqual(entry.direction, 'inbound');
    assert.strictEqual(entry.channel, 'voice');
  });

  // ── Compliance Status ─────────────────────────────────────────────────────

  test('getComplianceStatus returns correct counts for fully revoked customer', () => {
    consentStore.grant({ customerId: 'cust_revoked', consentType: CONSENT_TYPES.SMS_INBOUND });
    const handler = new TcpaStopWordHandler({ consentStore, logger: () => {} });
    handler.handleStopWord('STOP', 'cust_revoked', 'sms');

    const status = handler.getComplianceStatus('cust_revoked');
    assert.strictEqual(status.customerId, 'cust_revoked');
    assert.strictEqual(status.canSendSms, false);
    assert.ok(status.fullyRevoked);
  });
});
