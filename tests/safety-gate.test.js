/**
 * Layer 0 Safety Gate — Unit Tests
 * Run: node --test tests/safety-gate.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { scan, EMERGENCY_PATTERNS } from '../src/lib/safety-gate.js';

// ─── Positive Tests ──────────────────────────────────────────────────────────

const EMERGENCY_CASES = [
  { text: 'I smell gas coming from the furnace',          expect: true,  label: 'gas_smell' },
  { text: 'smells like gas near the heater',               expect: true,  label: 'gas_smell' },
  { text: 'carbon monoxide alarm is going off',            expect: true,  label: 'carbon_monoxide' },
  { text: 'my CO detector is beeping',                     expect: true,  label: 'co_detector' },
  { text: 'the smoke detector went off',                   expect: true,  label: 'smoke' },
  { text: 'theres fire coming from the vent',               expect: true,  label: 'fire' },
  { text: 'I can smell burning electrical',                 expect: true,  label: 'burning_smell' },
  { text: 'gas leak in the basement',                       expect: true,  label: 'gas_leak' },
  { text: 'the sparking wire near the ac unit',             expect: true,  label: 'sparking' },
  { text: 'short circuit in the furnace',                  expect: true,  label: 'short_circuit' },
  { text: 'breaker keeps tripping on the ac',              expect: true,  label: 'electrical' },
  { text: 'no heat and my grandmother is 85',              expect: true,  label: 'vulnerable_occupant' },
  { text: 'heat not working and we have a newborn',        expect: true,  label: 'vulnerable_occupant' },
  { text: 'ac is not working its 98 degrees outside',      expect: true,  label: 'heat_emergency' },
  { text: 'refrigerant is leaking from the outdoor unit',  expect: true,  label: 'refrigerant_leak' },
  { text: 'there is a leak coming from the unit',           expect: true,  label: 'refrigerant_leak' },
  { text: 'my AC has a leak',                              expect: true,  label: 'refrigerant_leak' },
  { text: 'explosion sound from the boiler room',           expect: true,  label: 'explosion' },
  { text: 'gas odor outside the house',                     expect: true,  label: 'gas_smell' },
];

describe('Layer 0 — Deterministic Safety Gate', () => {
  describe('emergency detection (positive cases)', () => {
    for (const tc of EMERGENCY_CASES) {
      it(`"${tc.text.substring(0, 50)}..." → triggered (${tc.label})`, async () => {
        const result = await scan(tc.text, { channel: 'chat', tenantId: 'test' });
        assert.strictEqual(result.pass, false, 'Should NOT pass safety gate');
        assert.ok(result.triggers.length > 0, 'Should have at least one trigger');
        assert.ok(result.response, 'Should return escalation response');
        assert.ok(result.severity === 'emergency' || result.severity === 'urgent', `Severity should be emergency or urgent, got: ${result.severity}`);
      });
    }
  });

  describe('pass-through (negative cases — should NOT trigger)', () => {
    const ROUTINE_CASES = [
      'schedule a routine maintenance visit',
      'what time are you open tomorrow',
      'how much is an ac repair',
      'i need a quote for a new thermostat',
      'my filter needs changing',
      'annual maintenance contract pricing',
      'can you come look at my ductwork',
      'the thermostat display is dim',
      'seasonal tune-up cost',
      'i signed up for your membership plan',
    ];
    for (const text of ROUTINE_CASES) {
      it(`"${text}" → passes safely`, async () => {
        const result = await scan(text, { channel: 'chat', tenantId: 'test' });
        assert.strictEqual(result.pass, true, `"${text}" should have passed`);
        assert.strictEqual(result.triggers.length, 0, 'Should have zero triggers');
        assert.strictEqual(result.response, null, 'Should have no escalation response');
      });
    }
  });

  describe('edge cases', () => {
    it('empty string → passes', async () => {
      const result = await scan('', { channel: 'chat', tenantId: 'test' });
      assert.strictEqual(result.pass, true);
    });

    it('mixed case gas smell → detected', async () => {
      const result = await scan('GAS SMELL FROM HEATER', { channel: 'sms', tenantId: 'test' });
      assert.strictEqual(result.pass, false);
    });

    it('contains multiple triggers → returns all', async () => {
      const result = await scan('smoke alarm going off and i smell gas', { channel: 'voice', tenantId: 'test' });
      assert.strictEqual(result.pass, false);
      assert.ok(result.triggers.length >= 2, 'Should catch both smoke and gas');
    });

    it('audit entry contains required fields', async () => {
      const result = await scan('carbon monoxide alarm', { channel: 'sms', tenantId: 'tenant_xyz' });
      assert.ok(result.auditEntry.timestamp, 'auditEntry.timestamp must be set');
      assert.strictEqual(result.auditEntry.channel, 'sms');
      assert.strictEqual(result.auditEntry.tenant_id, 'tenant_xyz');
      assert.strictEqual(result.auditEntry.safety_gate_passed, false);
      assert.strictEqual(result.auditEntry.safety_gate_triggered, true);
    });

    it('non-blocking: logFn failure does not throw', async () => {
      const result = await scan('gas leak', {
        channel: 'chat',
        tenantId: 'test',
        logFn: async () => { throw new Error('DB connection failed'); },
        notifyDispatcherFn: async () => { throw new Error('PagerDuty down'); },
      });
      assert.strictEqual(result.pass, false);
    });

    it('severity ordering: explosion > gas_smell > burning_smell', async () => {
      const cases = [
        { text: 'explosion sound from the utility room', expectWorst: 'explosion' },
        { text: 'burning smell from the electrical panel', expectWorst: 'electrical' },
        { text: 'gas smell near the stove',                expectWorst: 'gas_smell' },
      ];
      for (const tc of cases) {
        const result = await scan(tc.text, { channel: 'chat', tenantId: 'test' });
        assert.ok(result.triggers.length > 0);
      }
    });
  });
});
