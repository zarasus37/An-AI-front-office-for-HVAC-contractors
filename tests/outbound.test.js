/**
 * tests/outbound.test.js
 * TCPA consent enforcement and outbound SMS — the compliance-critical path
 * for all proactive outreach (renewals, IoT alerts, proactive leads).
 *
 * Key behaviors tested:
 *   - canSendOutboundSms: null/undefined customerId → always allowed (phone fallback)
 *   - canSendOutboundSms: active SMS_INBOUND consent → allowed
 *   - canSendOutboundSms: no record / revoked / wrong channel → blocked
 *   - sendOutboundSms: missing Twilio env → throws before any network call
 *   - sendOutboundSms: TCPA blocked → throws before any network call
 *   - sendOutboundSms: success → returns SID, correct To/From/Body
 *   - sendOutboundSms: Twilio error → throws with status + body
 *   - sendOutboundSms: network failure → throws
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ConsentStore, CONSENT_TYPES } from '../src/compliance/consent-store.js';
import { canSendOutboundSms, sendOutboundSms } from '../src/channels/outbound.js';

// ── canSendOutboundSms tests ─────────────────────────────────────────────────

describe('canSendOutboundSms — TCPA consent checks', () => {
  it('allows send when customerId is null (phone-only fallback)', () => {
    const result = canSendOutboundSms(null, '+15551111111');
    assert.deepStrictEqual(result, { allowed: true, reason: null });
  });

  it('allows send when customerId is undefined', () => {
    const result = canSendOutboundSms(undefined, '+15551111111');
    assert.deepStrictEqual(result, { allowed: true, reason: null });
  });

  it('allows send when customer has active SMS_INBOUND consent', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust_active', channel: 'sms', consentType: CONSENT_TYPES.SMS_INBOUND });
    const result = canSendOutboundSms('cust_active', '+15551111111', store);
    assert.deepStrictEqual(result, { allowed: true, reason: null });
  });

  it('blocks send when customer has no consent record at all', () => {
    const store = new ConsentStore();
    const result = canSendOutboundSms('cust_no_record', '+15551111111', store);
    assert.deepStrictEqual(result, {
      allowed: false,
      reason: 'No active SMS consent for customer cust_no_record',
    });
  });

  it('blocks send when SMS consent was granted then revoked', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust_revoked', channel: 'sms', consentType: CONSENT_TYPES.SMS_INBOUND });
    store.revoke({ customerId: 'cust_revoked', channel: 'sms', consentType: CONSENT_TYPES.SMS_INBOUND });
    const result = canSendOutboundSms('cust_revoked', '+15551111111', store);
    assert.deepStrictEqual(result, {
      allowed: false,
      reason: 'No active SMS consent for customer cust_revoked',
    });
  });

  it('blocks send when only call_recording consent exists (wrong channel)', () => {
    const store = new ConsentStore();
    store.grant({ customerId: 'cust_call_only', channel: 'voice', consentType: CONSENT_TYPES.CALL_RECORDING });
    const result = canSendOutboundSms('cust_call_only', '+15551111111', store);
    assert.deepStrictEqual(result, {
      allowed: false,
      reason: 'No active SMS consent for customer cust_call_only',
    });
  });
});

// ── sendOutboundSms — missing credentials ──────────────────────────────────────

describe('sendOutboundSms — missing Twilio credentials', () => {
  it('throws when TWILIO_ACCOUNT_SID is not set', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Hello' }),
      /Twilio credentials not configured/
    );
  });

  it('throws when TWILIO_AUTH_TOKEN is not set', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Hello' }),
      /Twilio credentials not configured/
    );
  });

  it('throws when TWILIO_FROM_NUMBER is not set', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    delete process.env.TWILIO_FROM_NUMBER;
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Hello' }),
      /Twilio credentials not configured/
    );
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
});

// ── sendOutboundSms — TCPA enforcement ─────────────────────────────────────────

describe('sendOutboundSms — TCPA enforcement', () => {
  // Stash and restore globalThis.fetch between describe blocks
  const _orig = globalThis.fetch;

  it('throws TCPA error before making any network call when customer has no consent', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    process.env.TWILIO_FROM_NUMBER = '+15552222222';

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ sid: 'SM_should_not_reach' }) };
    };

    const store = new ConsentStore(); // empty — no consent records
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Renewal reminder', customerId: 'noconsent', consentStore: store }),
      /TCPA blocked.*No active SMS consent/
    );
    assert.strictEqual(fetchCalled, false, 'Twilio fetch must not be called when TCPA blocks');

    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('allows send with null customerId (phone-only fallback) and no fetch is called before TCPA check', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    process.env.TWILIO_FROM_NUMBER = '+15552222222';

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ sid: 'SM_reached' }) };
    };

    const store = new ConsentStore();
    const sid = await sendOutboundSms({ to: '+15551111111', body: 'Test', customerId: null, consentStore: store });
    assert.strictEqual(sid, 'SM_reached');
    assert.strictEqual(fetchCalled, true);

    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });
});

// ── sendOutboundSms — Twilio API ──────────────────────────────────────────────

describe('sendOutboundSms — Twilio API', () => {
  const _orig = globalThis.fetch;

  it('calls Twilio with correct To/From/Body fields and returns SID', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    process.env.TWILIO_FROM_NUMBER = '+15552222222';

    globalThis.fetch = async (url, opts) => {
      const form = new URLSearchParams(opts.body);
      assert.match(url, /api\.twilio\.com.*Messages\.json/);
      assert.strictEqual(form.get('To'), '+15551111111');
      assert.strictEqual(form.get('From'), '+15552222222');
      assert.strictEqual(form.get('Body'), 'Your AC maintenance plan is up for renewal.');
      assert.ok(opts.headers.Authorization, 'Has Authorization header');
      return {
        ok: true,
        json: async () => ({ sid: 'SM1234567890abcdef' }),
      };
    };

    const store = new ConsentStore();
    const sid = await sendOutboundSms({ to: '+15551111111', body: 'Your AC maintenance plan is up for renewal.', consentStore: store });
    assert.strictEqual(sid, 'SM1234567890abcdef');

    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('throws with Twilio error status and response body on failure', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    process.env.TWILIO_FROM_NUMBER = '+15552222222';

    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Invalid phone number format',
    });

    const store = new ConsentStore();
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Test', consentStore: store }),
      /Twilio error 400.*Invalid phone number format/
    );

    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('throws on network failure', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'testauth';
    process.env.TWILIO_FROM_NUMBER = '+15552222222';

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const store = new ConsentStore();
    await assert.rejects(
      () => sendOutboundSms({ to: '+15551111111', body: 'Test', consentStore: store }),
      /ECONNREFUSED/
    );

    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });
});
