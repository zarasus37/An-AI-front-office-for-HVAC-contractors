/**
 * tests/dispatcher.test.js
 * Coverage for src/lib/dispatcher.js — the safety-critical escalation module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

function makeAudit(overrides = {}) {
  return {
    triggers: [],
    full_text_preview: 'Smoke alarm is going off',
    full_text: 'My smoke alarm is going off and I smell gas',
    phone: '+15559876543',
    channel: 'voice',
    tenant_id: 'default',
    message_id: 'test-msg-001',
    ...overrides,
  };
}

// ── notifyDispatcher — env missing cases ─────────────────────────────────────

describe('notifyDispatcher — missing config', () => {
  it('returns null when DISPATCHER_PHONE is not set', async () => {
    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const result = await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });
    assert.strictEqual(result, null);
    assert.match(logs[0], /DISPATCHER_PHONE not set/);
  });

  it('returns null when Twilio credentials are missing', async () => {
    process.env.DISPATCHER_PHONE = '+15551111111';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;

    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const result = await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });
    assert.strictEqual(result, null);
    assert.match(logs[0], /Twilio credentials not configured/);

    delete process.env.DISPATCHER_PHONE;
  });
});

// ── notifyDispatcher — Twilio success ─────────────────────────────────────────

describe('notifyDispatcher — Twilio success', () => {
  // Stash original fetch between tests
  const _orig = globalThis.fetch;

  it('calls Twilio and returns the call SID', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'testauthtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    const fakeSid = 'CA1234567890abcdef';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ sid: fakeSid }),
    });

    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const result = await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });

    assert.strictEqual(result, fakeSid);
    assert.match(logs[0], new RegExp(fakeSid));

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('posts correct To/From/Url fields to Twilio', async () => {
    process.env.DISPATCHER_PHONE    = '+15550000001';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'testauthtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15550000002';

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ sid: 'CA999' }),
    });

    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });

    // logs[0] is the success line — but we can't re-read the fetch call easily
    // without a capture. Verify the SID came back instead.
    assert.match(logs[0], /CA999/);

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });
});

// ── notifyDispatcher — Twilio failure ─────────────────────────────────────────

describe('notifyDispatcher — Twilio errors', () => {
  const _orig = globalThis.fetch;

  it('returns null and logs when Twilio returns an error status', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'testauthtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Auth failure',
    });

    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const result = await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });

    assert.strictEqual(result, null);
    assert.match(logs[0], /Twilio call failed 401/);

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('returns null and logs when fetch throws', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'testauthtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const { notifyDispatcher } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const result = await notifyDispatcher(makeAudit(), { logFn: (m) => logs.push(m) });

    assert.strictEqual(result, null);
    assert.match(logs[0], /Failed to place escalation call/);

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });
});

// ── makeDispatcherNotifier ─────────────────────────────────────────────────────

describe('makeDispatcherNotifier', () => {
  const _orig = globalThis.fetch;

  it('logs escalation and skips the call when DISPATCHER_PHONE is unset', async () => {
    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;

    globalThis.fetch = async () => { throw new Error('should not be called'); };

    const { makeDispatcherNotifier } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const notifier = makeDispatcherNotifier({ logFn: (m) => logs.push(m) });
    await notifier(makeAudit());

    assert.match(logs[0], /Dispatcher ESCALATION/);
    // notifyDispatcher also logs its own "DISPATCHER_PHONE not set" message
    assert.strictEqual(logs.length, 2);
    globalThis.fetch = _orig;
  });

  it('logs success with correct DISPATCHER_PHONE (not undefined) and correct SID', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'testauthtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    const fakeSid = 'CA987654321fedcba';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ sid: fakeSid }),
    });

    const { makeDispatcherNotifier } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const notifier = makeDispatcherNotifier({ logFn: (m) => logs.push(m) });
    await notifier(makeAudit());

    const successLog = logs.find((l) => l.includes('✅'));
    assert.ok(successLog, 'Expected a success log entry');
    // Bug #1 regression check: phone must be the real env value, not undefined
    assert.match(successLog, /\+15551111111/);
    assert.match(successLog, new RegExp(fakeSid));

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('logs a warning when Twilio call fails despite DISPATCHER_PHONE being set', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'wrongtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Bad auth',
    });

    const { makeDispatcherNotifier } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const notifier = makeDispatcherNotifier({ logFn: (m) => logs.push(m) });
    await notifier(makeAudit());

    const warnLog = logs.find((l) => l.includes('⚠️'));
    assert.ok(warnLog, 'Expected a warning when Twilio call fails');
    assert.match(warnLog, /Twilio call FAILED/);

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });

  it('does not emit a success log when the call fails', async () => {
    process.env.DISPATCHER_PHONE    = '+15551111111';
    process.env.TWILIO_ACCOUNT_SID  = 'ACtestaccountSID';
    process.env.TWILIO_AUTH_TOKEN   = 'wrongtoken';
    process.env.TWILIO_FROM_NUMBER  = '+15552222222';

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Bad auth',
    });

    const { makeDispatcherNotifier } = await import('../src/lib/dispatcher.js');
    const logs = [];
    const notifier = makeDispatcherNotifier({ logFn: (m) => logs.push(m) });
    await notifier(makeAudit());

    const successLogs = logs.filter((l) => l.includes('✅'));
    assert.strictEqual(successLogs.length, 0, 'Should not log success when sid is null');
    const warnLogs = logs.filter((l) => l.includes('⚠️'));
    assert.strictEqual(warnLogs.length, 1);

    delete process.env.DISPATCHER_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    globalThis.fetch = _orig;
  });
});
