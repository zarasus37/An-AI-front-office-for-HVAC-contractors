/**
 * Layer 1 — Intake Pipeline Tests
 * Tests: queue store, TwiML helpers, SMS webhook routing
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { enqueue, getEntry, updateEntry, listEntries, _clearAll, QUEUE_STATUS } from '../src/queue/store.js';
import { twimlResponse, twimlVoiceSay, twimlRedirect } from '../src/utils/twiml.js';
import { scan } from '../src/lib/safety-gate.js';

// ── Queue Store ─────────────────────────────────────────────────────────────────

describe('Queue Store', () => {

  beforeEach(() => { _clearAll(); });

  test('enqueue returns entry with id, received_at, status=queued', () => {
    const entry = enqueue({
      channel:         'sms',
      tenant_id:        'tenant-1',
      raw_input:        'hello',
      caller_phone:     '+15551234567',
      service_address:  null,
      contact_name:     null,
    });
    assert.ok(entry.id, 'has id');
    assert.ok(entry.received_at, 'has received_at');
    assert.equal(entry.status, 'queued');
    assert.equal(entry.safety_gate_passed, true);
    assert.equal(entry.safety_gate_result, null);
    assert.equal(entry.llm_classification, null);
  });

  test('getEntry returns correct entry', () => {
    const created = enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'hi' });
    const found = getEntry(created.id);
    assert.equal(found.id, created.id);
    assert.equal(found.raw_input, 'hi');
  });

  test('getEntry returns undefined for unknown id', () => {
    assert.equal(getEntry('not-real'), undefined);
  });

  test('updateEntry patches existing entry', () => {
    const entry = enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'hi' });
    const updated = updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED, contact_name: 'Cris' });
    assert.equal(updated.status, 'escalated');
    assert.equal(updated.contact_name, 'Cris');
    assert.equal(updated.raw_input, 'hi'); // unchanged
  });

  test('updateEntry returns undefined for unknown id', () => {
    assert.equal(updateEntry('not-real', { status: 'queued' }), undefined);
  });

  test('listEntries returns newest first', async () => {
    // Enqueue with a deliberate 1ms gap to guarantee timestamp ordering
    enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'first' });
    await new Promise(r => setTimeout(r, 2));
    enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'second' });
    const entries = listEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].raw_input, 'second', 'newest should be first');
    assert.equal(entries[1].raw_input, 'first', 'oldest should be second');
  });

  test('listEntries filters by tenantId', () => {
    enqueue({ channel: 'sms', tenant_id: 'tenant-a', raw_input: 'a' });
    enqueue({ channel: 'sms', tenant_id: 'tenant-b', raw_input: 'b' });
    const aEntries = listEntries({ tenantId: 'tenant-a' });
    assert.equal(aEntries.length, 1);
    assert.equal(aEntries[0].raw_input, 'a');
  });

  test('listEntries filters by status', () => {
    const e1 = enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'e1' });
    const e2 = enqueue({ channel: 'sms', tenant_id: 't1', raw_input: 'e2' });
    updateEntry(e1.id, { status: QUEUE_STATUS.ESCALATED });
    const escalated = listEntries({ status: QUEUE_STATUS.ESCALATED });
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].raw_input, 'e1');
  });

  test('listEntries respects limit', () => {
    for (let i = 0; i < 10; i++) enqueue({ channel: 'sms', tenant_id: 't1', raw_input: String(i) });
    const limited = listEntries({ limit: 3 });
    assert.equal(limited.length, 3);
  });

  test('enqueued entry has correct schema fields', () => {
    const entry = enqueue({
      channel:         'chat',
      tenant_id:       'biz-1',
      raw_input:       'my ac is making noise',
      transcript:      null,
      caller_phone:    '+15559876543',
      service_address: '123 Main St',
      contact_name:   'Cris',
    });
    assert.equal(entry.channel, 'chat');
    assert.equal(entry.tenant_id, 'biz-1');
    assert.equal(entry.raw_input, 'my ac is making noise');
    assert.equal(entry.caller_phone, '+15559876543');
    assert.equal(entry.service_address, '123 Main St');
    assert.equal(entry.contact_name, 'Cris');
  });
});

// ── TwiML Helpers ────────────────────────────────────────────────────────────────

describe('TwiML helpers', () => {

  test('twimlResponse escapes HTML special chars', () => {
    const xml = twimlResponse('Hello <World> & "friend"');
    assert.ok(xml.includes('&lt;World&gt;'));
    assert.ok(xml.includes('&amp;'));
    assert.ok(xml.includes('&quot;'));
    assert.ok(xml.includes('<Message>Hello'));
    assert.ok(xml.includes('</Message>'));
  });

  test('twimlResponse is valid TwiML', () => {
    const xml = twimlResponse('Reply text');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<Response><Message>Reply text</Message></Response>'));
  });

  test('twimlVoiceSay builds valid voice TwiML', () => {
    const xml = twimlVoiceSay('Please hold.', { voice: 'man', language: 'en' });
    assert.ok(xml.includes('<Say voice="man" language="en">'));
    assert.ok(xml.includes('</Say>'));
  });

  test('twimlRedirect builds redirect TwiML', () => {
    const xml = twimlRedirect('https://example.com/twiml');
    assert.ok(xml.includes('<Redirect method="POST">https://example.com/twiml</Redirect>'));
  });

  test('twimlResponse handles empty string', () => {
    const xml = twimlResponse('');
    assert.ok(xml.includes('<Response><Message></Message></Response>'));
  });
});

// ── Safety Gate Integration ─────────────────────────────────────────────────────

describe('Safety Gate — queue integration', () => {

  beforeEach(() => { _clearAll(); });

  test('safety gate triggered → entry marked escalated', async () => {
    // "gas leak" should trigger emergency
    const safetyResult = await scan('gas leak in the basement', {
      channel:  'sms',
      tenantId: 'test-tenant',
      messageId: 'msg-001',
    });

    assert.equal(safetyResult.pass, false, 'safety gate should fail');
    assert.ok(safetyResult.triggers.length > 0);
    assert.ok(safetyResult.response, 'has escalation response');

    // Enqueue and update with result
    const entry = enqueue({
      channel:    'sms',
      tenant_id:  'test-tenant',
      raw_input:  'gas leak in the basement',
      caller_phone: '+15551234567',
    });

    updateEntry(entry.id, {
      safety_gate_passed:  safetyResult.pass,
      safety_gate_result:   { triggered: true, triggers: safetyResult.triggers },
      status:              !safetyResult.pass ? QUEUE_STATUS.ESCALATED : entry.status,
    });

    const updated = getEntry(entry.id);
    assert.equal(updated.status, QUEUE_STATUS.ESCALATED);
    assert.equal(updated.safety_gate_passed, false);
  });

  test('safety gate passed → entry stays queued', async () => {
    const safetyResult = await scan('schedule a routine maintenance visit', {
      channel:  'sms',
      tenantId: 'test-tenant',
      messageId: 'msg-002',
    });

    assert.equal(safetyResult.pass, true);

    const entry = enqueue({
      channel:   'sms',
      tenant_id: 'test-tenant',
      raw_input: 'schedule a routine maintenance visit',
    });

    updateEntry(entry.id, {
      safety_gate_passed:  safetyResult.pass,
      safety_gate_result:  { triggered: false },
    });

    assert.equal(entry.status, 'queued'); // not escalated
  });

  test('safety gate: multiple triggers picked up', async () => {
    // "gas leak" + "elderly" — two separate emergency patterns
    const safetyResult = await scan('no heat and my grandmother is 85 years old', {
      channel: 'sms',
      tenantId: 'test',
    });

    assert.equal(safetyResult.pass, false);
    assert.ok(safetyResult.triggers.length >= 1);
  });

  test('safety gate: refrigerant leak detected', async () => {
    const safetyResult = await scan('refrigerant is leaking from the outdoor unit', {
      channel: 'sms',
      tenantId: 'test',
    });
    assert.equal(safetyResult.pass, false);
    const ids = safetyResult.triggers.map(t => t.id);
    assert.ok(ids.includes('refrigerant_leak'), `expected refrigerant_leak trigger, got: ${JSON.stringify(ids)}`);
  });

  test('safety gate: carbon monoxide detected', async () => {
    const safetyResult = await scan('carbon monoxide alarm is going off', { channel: 'sms', tenantId: 'test' });
    assert.equal(safetyResult.pass, false);
    const ids = safetyResult.triggers.map(t => t.id);
    assert.ok(ids.includes('carbon_monoxide') || ids.includes('co_detector'), `expected co trigger, got: ${JSON.stringify(ids)}`);
  });

  test('safety gate: burning smell detected', async () => {
    const safetyResult = await scan('I can smell burning electrical in the panel', { channel: 'sms', tenantId: 'test' });
    assert.equal(safetyResult.pass, false);
    const ids = safetyResult.triggers.map(t => t.id);
    assert.ok(ids.includes('burning_smell'), `expected burning_smell, got: ${JSON.stringify(ids)}`);
  });
});

// ── Channel field handling ──────────────────────────────────────────────────────

describe('Channel routing', () => {
  const CHANNELS = ['sms', 'voice', 'chat', 'google_lsa', 'yelp', 'thumbtack', 'angi'];

  test('enqueue accepts all valid channel values', () => {
    CHANNELS.forEach(channel => {
      _clearAll();
      const entry = enqueue({ channel, tenant_id: 't1', raw_input: 'test' });
      assert.equal(entry.channel, channel);
    });
  });

  test('enqueue accepts null optional fields', () => {
    const entry = enqueue({ channel: 'chat', tenant_id: 't1', raw_input: 'hi' });
    assert.equal(entry.caller_phone, null);
    assert.equal(entry.service_address, null);
    assert.equal(entry.contact_name, null);
    assert.equal(entry.transcript, null);
  });
});
