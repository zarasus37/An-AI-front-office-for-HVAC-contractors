/**
 * Web Chat Channel — Integration Tests
 *
 * Tests:
 *   1. Widget config endpoint returns expected shape
 *   2. Chat endpoint requires message field
 *   3. Chat endpoint returns JSON with text + classification
 *   4. Chat endpoint: safety gate escalation → JSON with escalated intent
 *   5. Chat endpoint: stop-word → JSON with stop_received
 *   6. Chat endpoint: schedule_service → returns suggestions
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';

// ── Imports ─────────────────────────────────────────────────────────────────────

import { registerWebRoutes } from '../src/channels/web.js';
import { enqueue, _clearAll as clearQueue } from '../src/queue/store.js';
import { _clearAll as clearSessions } from '../src/conversation/session.js';
import { consentStore } from '../src/compliance/consent-store.js';

// ── Test app factory ────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  registerWebRoutes(app);
  return app;
}

// ── Minimal supertest-like helper ─────────────────────────────────────────────

/**
 * Fire a request against an Express app without a network round-trip.
 */
import http from 'http';

function request(app, method, path, body = null, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      // Defer close so the response fully propagates before socket teardown
      setImmediate(() => server.close(() => {}));
      resolve(result);
    };
    server.listen(0, () => {
      const port = server.address().port;
      const reqOpts = {
        hostname: 'localhost',
        port,
        path,
        method: method,
        headers: { 'Content-Type': 'application/json', ...headers },
      };

      const req = http.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = data; }
          done({ status: res.statusCode, headers: res.headers, body: json });
        });
      });

      req.on('error', (err) => done({ status: 0, body: null, error: err.message }));
      req.on('timeout', () => { req.destroy(); done({ status: 0, body: null, error: 'timeout' }); });

      if (body) req.write(JSON.stringify(body));
      req.end();

      // Safety timeout to prevent test from hanging forever
      setTimeout(() => done({ status: 0, body: null, error: 'timeout' }), 8000);
    });
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Web Chat Channel', () => {

  beforeEach(() => {
    clearQueue();
    clearSessions();
    consentStore._reset();
  });

  // ── Widget Config ──────────────────────────────────────────────────────────

  test('GET /web/chat returns widget config', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/web/chat');

    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.company === 'string');
    assert.ok(typeof res.body.welcomeMessage === 'string');
    assert.ok(typeof res.body.accentColor === 'string');
    assert.strictEqual(res.body.mode, 'live');
    assert.ok(res.body.features);
    assert.strictEqual(res.body.features.smsFollowUp, true);
  });

  // ── POST /web/chat ─────────────────────────────────────────────────────────

  test('POST /web/chat requires message field', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {});

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.error.toLowerCase().includes('message'));
  });

  test('POST /web/chat accepts minimal valid message', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', { message: 'Hello' });

    assert.strictEqual(res.status, 200, `body: ${JSON.stringify(res.body).slice(0,200)}`);
    assert.ok(res.body.text, `body: ${JSON.stringify(res.body).slice(0,200)}`);
    assert.ok(typeof res.body.classification === 'object', `body: ${JSON.stringify(res.body).slice(0,200)}`);
    assert.ok(Array.isArray(res.body.suggestions), `body: ${JSON.stringify(res.body).slice(0,200)}`);
  });

  test('POST /web/chat returns suggestions for schedule_service intent', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {
      message: 'I need to schedule an AC repair',
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.suggestions.length > 0);
  });

  test('POST /web/chat returns suggestions for quote_request intent', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {
      message: 'How much does an AC tune-up cost?',
    });

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.suggestions));
  });

  test('POST /web/chat: stop-word returns stop_received classification', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {
      message: 'STOP',
      phone:   '+15550009999',
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.text.toLowerCase().includes('unsubscribed'));
    assert.strictEqual(res.body.classification?.intent, 'stop_received');
  });

  test('POST /web/chat: safety gate escalation returns escalated response', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {
      message: "My smoke alarm is going off and I smell gas",
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.text.length > 0);
    assert.strictEqual(res.body.classification?.urgency, 'emergency');
  });

  test('POST /web/chat includes entryId and sessionId in response', async () => {
    const app = makeApp();
    const sessionId = 'test-session-123';
    const res = await request(app, 'POST', '/web/chat', {
      sessionId,
      message:   'Test message',
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.entryId);
    assert.strictEqual(res.body.sessionId, sessionId);
  });

  test('POST /web/chat with name/phone/email passes through to queue', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', {
      message: 'AC is broken',
      name:    'Jane Doe',
      phone:   '+15551234567',
      email:   'jane@example.com',
      address: '456 Oak St, Weslaco TX 78596',
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.entryId);
  });

  test('POST /web/chat: empty message returns 400', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/web/chat', { message: '' });
    assert.strictEqual(res.status, 400);
  });

  // ── History endpoint ────────────────────────────────────────────────────────

  test('GET /web/chat/history/:sessionId returns messages array', async () => {
    const app = makeApp();

    // First send a message to populate session
    await request(app, 'POST', '/web/chat', { message: 'Hello', sessionId: 'sess-abc' });

    // Then get history
    const res = await request(app, 'GET', '/web/chat/history/sess-abc');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
  });

  test('GET /web/chat/history/:id requires sessionId', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/web/chat/history/');
    // Returns 404 because route doesn't match without sessionId
    assert.strictEqual(res.status, 404);
  });
});
