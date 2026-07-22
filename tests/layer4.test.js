/**
 * Layer 4 — IoT Predictive Triage Tests
 * Tests: ThermostatSignalExtractor, Ecobee signature verification
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ThermostatSignalExtractor, verifyEcobeeSignature } from '../src/iot/thermostat.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal Ecobee-style runtime report */
function makeReport(columns, rows) {
  return { columns, rows };
}

/** Empty baseline */
const EMPTY_BASELINE = { avgRuntime: 0, avgCycleCount: 0 };

/** Mock logger */
function mockLog() {}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ThermostatSignalExtractor — signal extraction', () => {

  test('SHORT_CYCLING: triggers when 3+ short cycles in 2-hour window', () => {
    // Columns: date, hour, thermostat_identifier, compCool1 (runtime per 15-min slot)
    const report = makeReport(
      ['date','hour','thermostat_identifier','compCool1'],
      [
        ['2024-07-20','10','abc123', 60],  // 60 sec = short cycle
        ['2024-07-20','10','abc123', 60],
        ['2024-07-20','11','abc123', 60],  // 3 events in window
      ]
    );

    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, EMPTY_BASELINE, {});
    const sc = signals.find(s => s.type === 'short_cycling');
    assert.ok(sc, 'short_cycling signal should be present');
    assert.strictEqual(sc.severity, 'elevated');
    assert.ok(sc.message.includes('Short-cycling'), 'message should mention short-cycling');
  });

  test('SHORT_CYCLING: does not fire for normal cycles', () => {
    const report = makeReport(
      ['date','hour','thermostat_identifier','compCool1'],
      [
        ['2024-07-20','10','abc123', 300],  // 300 sec = 5 min = normal
        ['2024-07-20','11','abc123', 320],
      ]
    );

    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, EMPTY_BASELINE, {});
    const sc = signals.find(s => s.type === 'short_cycling');
    assert.strictEqual(sc, undefined, 'no short-cycling signal for normal cycles');
  });

  test('RUNTIME_ANOMALY: fires when runtime > 1.5x baseline', () => {
    const report = makeReport(
      ['date','hour','thermostat_identifier','compCool1'],
      [
        ['2024-07-20','10','abc123', 400],
        ['2024-07-20','10','abc123', 400],
        ['2024-07-20','11','abc123', 400],
        ['2024-07-20','11','abc123', 400],
        ['2024-07-20','12','abc123', 400],
        ['2024-07-20','12','abc123', 400],
        ['2024-07-20','13','abc123', 400],
        ['2024-07-20','13','abc123', 400],
      ]
    );

    const baseline = { avgRuntime: 200, avgCycleCount: 4 }; // avg per hour
    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, baseline, {});
    const ra = signals.find(s => s.type === 'runtime_anomaly');
    assert.ok(ra, 'runtime_anomaly signal should be present');
    assert.strictEqual(ra.severity, 'elevated');
  });

  test('SETPOINT_FAILURE: fires when temp stays below setpoint for 2+ hours', () => {
    // 9 hours of data (each row = 15 min, so 36 rows = 9 hours)
    const rows = [];
    for (let h = 10; h < 19; h++) {
      for (let q = 0; q < 4; q++) {
        rows.push(['2024-07-20', String(h).padStart(2,'0'), 'abc123', 80, 1, 0]);
      }
    }

    const report = makeReport(
      ['date','hour','thermostat_identifier','insideTemperature','cool1','heat1'],
      rows
    );

    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, EMPTY_BASELINE, {});
    const sf = signals.find(s => s.type === 'setpoint_failure');
    assert.ok(sf, 'setpoint_failure signal should be present');
    assert.ok(sf.sustained_minutes >= 120, `sustained_minutes=${sf.sustained_minutes} should be >= 120`);
  });

  test('AUX_HEAT_OVERSHOOT: fires when aux heat > 40% of heat pump runtime', () => {
    // 20 rows × 15 min = 5 hours; auxHeat1=9000s (2.5h), heatPump1=18000s (5h) → ratio=0.5 > 0.4
    const report = makeReport(
      ['date','hour','thermostat_identifier','auxHeat1','heatPump1'],
      Array.from({ length: 20 }, () => ['2024-01-15', '08', 'abc123', 9000, 18000])
    );

    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, EMPTY_BASELINE, {});
    const aux = signals.find(s => s.type === 'aux_heat_overshoot');
    assert.ok(aux, 'aux_heat_overshoot signal should be present');
  });

  test('HUMIDITY_ELEVATION: fires when humidity rises >= 8 percentage points', () => {
    const report = makeReport(
      ['date','hour','thermostat_identifier','insideHumidity'],
      [
        // Day 1: 40% humidity
        ['2024-07-20', '10', 'abc123', 40],
        ['2024-07-20', '11', 'abc123', 40],
        ['2024-07-20', '12', 'abc123', 40],
        // Day 2: 49% humidity — rise of 9 points
        ['2024-07-21', '10', 'abc123', 49],
        ['2024-07-21', '11', 'abc123', 49],
      ]
    );

    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, EMPTY_BASELINE, {});
    const hum = signals.find(s => s.type === 'humidity_elevation');
    assert.ok(hum, 'humidity_elevation signal should be present');
    assert.ok(hum.rise_pct >= 8, `rise_pct=${hum.rise_pct} should be >= 8`);
  });

  test('returns empty array when no signals detected', () => {
    // Use 8 rows (2 hours of data) so annualized rate ≈ actual rate
    const report = makeReport(
      ['date','hour','thermostat_identifier','compCool1','insideTemperature','insideHumidity','auxHeat1','heatPump1'],
      [
        ['2024-07-20','10','abc123', 300, 74, 45, 0, 0],
        ['2024-07-20','10','abc123', 300, 74, 45, 0, 0],
        ['2024-07-20','11','abc123', 280, 74, 45, 0, 0],
        ['2024-07-20','11','abc123', 320, 74, 45, 0, 0],
        ['2024-07-20','12','abc123', 310, 74, 45, 0, 0],
        ['2024-07-20','12','abc123', 290, 74, 45, 0, 0],
        ['2024-07-20','13','abc123', 300, 74, 45, 0, 0],
        ['2024-07-20','13','abc123', 300, 74, 45, 0, 0],
      ]
    );

    // Baseline: avgRuntimePerHour = totalRuntime/reportHours = 2400/2 = 1200 sec/hour
    // No anomaly when 1200 <= baseline * 1.5 → baseline >= 800; use 800
    const extractor = new ThermostatSignalExtractor({ logger: mockLog });
    const signals = extractor.extractFromEcobeeReport(report, { avgRuntime: 800, avgCycleCount: 2 }, {});
    assert.strictEqual(signals.length, 0, 'no signals for normal operating conditions');
  });

  test('normalizeWebhookPayload handles event-style payload', () => {
    const payload = {
      event: {
        thermostatIdentifier: 'ABC123',
        type: 'runtime_report',
        timestamp: '2024-07-20T14:00:00Z',
        runtimeReport: { columns: ['date','hour'], rows: [] },
      }
    };

    const normalized = ThermostatSignalExtractor.normalizeWebhookPayload(payload);
    assert.strictEqual(normalized.thermostat_serial, 'ABC123');
    assert.strictEqual(normalized.event_type, 'runtime_report');
    assert.ok(Array.isArray(normalized.runtime_report?.rows));
  });

  test('normalizeWebhookPayload handles flat-style payload', () => {
    const payload = {
      thermostat_serial: 'XYZ789',
      eventType: 'alert',
      temperature: 82,
      humidity: 60,
    };

    const normalized = ThermostatSignalExtractor.normalizeWebhookPayload(payload);
    assert.strictEqual(normalized.thermostat_serial, 'XYZ789');
    assert.strictEqual(normalized.telemetry?.temperature, 82);
    assert.strictEqual(normalized.telemetry?.humidity, 60);
  });
});

describe('ThermostatSignalExtractor — Ecobee signature verification', () => {

  test('verifyEcobeeSignature returns true for valid signature', async () => {
    const { createHmac } = await import('crypto');

    const secret = 'test-secret';
    const url    = 'https://example.com/webhooks/ecobee';
    const body   = '{"event":{"type":"test"}}';

    const expectedSig = createHmac('sha256', secret)
      .update(url + body, 'utf8')
      .digest('base64');

    const result = verifyEcobeeSignature(expectedSig, url, body, secret);
    assert.strictEqual(result, true);
  });

  test('verifyEcobeeSignature returns false for invalid signature', () => {
    const result = verifyEcobeeSignature('invalid-sig', 'https://example.com/webhook', '{}', 'secret');
    assert.strictEqual(result, false);
  });

  test('verifyEcobeeSignature returns false when secret is missing', () => {
    assert.strictEqual(verifyEcobeeSignature('sig', 'url', 'body', ''), false);
    assert.strictEqual(verifyEcobeeSignature('sig', 'url', 'body', null), false);
  });
});
