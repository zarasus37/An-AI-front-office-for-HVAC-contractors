/**
 * Layer 4 — IoT Predictive Triage
 *
 * Signal extraction from thermostat telemetry.
 * Sources: Ecobee (primary), Nest, Honeywell/Resideo.
 *
 * Buildable signals:
 *  - Short-cycling: compressor cycles < 5 min on, short off
 *  - Runtime anomalies: vs. customer baseline
 *  - Failure-to-reach-setpoint
 *  - Auxiliary-heat overshoot (failing reversing valve)
 *  - Humidity elevation trends
 *
 * NOT extractable (requires truck roll):
 *  - Refrigerant charge faults
 *  - Airflow/duct static pressure faults
 *  - Compressor electrical faults
 */

import { createHmac } from 'crypto';

// ── Ecobee Signature Verification ────────────────────────────────────────────

/**
 * Verify Ecobee webhook signature per Ecobee API docs.
 * Ecobee signs requests using HMAC-SHA256 with the shared secret.
 * The signature is sent as base64 in x-ecobee-signature header.
 *
 * @param {string} signature  - base64 signature from header
 * @param {string} url        - full request URL including query string
 * @param {string} body       - raw request body (string)
 * @param {string} consumerSecret - Ecobee app consumer secret
 * @returns {boolean}
 */
export function verifyEcobeeSignature(signature, url, body, consumerSecret) {
  if (!signature || !consumerSecret) return false;
  const payload = url + body;
  const expected = createHmac('sha256', consumerSecret)
    .update(payload, 'utf8')
    .digest('base64');
  // Constant-time compare to avoid timing attacks
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ── Signal Thresholds ─────────────────────────────────────────────────────────

export const THRESHOLDS = {
  // Short-cycling: compressor on-duration below this (seconds) = short cycle
  SHORT_CYCLE_ON_MAX:        300,   // 5 minutes
  // Minimum off-duration to be considered a full cycle (seconds)
  SHORT_CYCLE_OFF_MIN:        180,   // 3 minutes
  // How many short cycles in a window triggers a signal
  SHORT_CYCLE_COUNT_WINDOW:  7200,  // 2-hour window
  SHORT_CYCLE_COUNT_TRIGGER:    3,   // 3+ events in window
  // Runtime anomaly: current runtime > (baseline * multiplier) = anomaly
  RUNTIME_ANOMALY_MULT:        1.5,
  // Failure-to-reach-setpoint: degrees difference sustained for N minutes
  SETPOINT_DELTA_TRIGGER:        4,  // degrees F
  SETPOINT_SUSTAINED_MIN:      120, // minutes at delta
  // Aux heat overshoot: aux runtime > (primary heat runtime * ratio)
  AUX_OVERRIDE_MULT:            0.4,
  AUX_OVERSHOOT_TRIGGER:       180, // 3+ hours aux in a day = failing valve
  // Humidity: relative rise > this % in 24h = elevation trend
  HUMIDITY_RISE_TRIGGER:         8,  // percentage points
  HUMIDITY_WINDOW:            86400, // 24 hours in seconds
};

// ── Signal Types ─────────────────────────────────────────────────────────────

export const SIGNAL_TYPES = {
  SHORT_CYCLING:       'short_cycling',
  RUNTIME_ANOMALY:     'runtime_anomaly',
  SETPOINT_FAILURE:    'setpoint_failure',
  AUX_HEAT_OVERSHOOT:  'aux_heat_overshoot',
  HUMIDITY_ELEVATION:  'humidity_elevation',
};

// ── Signal Extractor ─────────────────────────────────────────────────────────

export class ThermostatSignalExtractor {
  /**
   * @param {object} opts
   * @param {object} opts.thresholds  - override THRESHOLDS values
   * @param {object} opts.logger      - optional logger function
   */
  constructor(opts = {}) {
    this._t = { ...THRESHOLDS, ...opts.thresholds };
    this._log = opts.logger ?? (() => {});
  }

  /**
   * Extract signals from Ecobee runtime report data.
   *
   * Ecobee runtime report structure:
   * {
   *   columns: ["date","hour","thermostat_identifier",...],
   *   rows: [["2024-07-20","14","abc123",0,120,45,...], ...],
   *   runtimeMetricSpec: { sensors: [...], metrics: [...] }
   * }
   *
   * @param {object} report  - Ecobee runtime report
   * @param {object} baseline - { avgRuntime: number, avgCycleCount: number } per 15-min slot
   * @param {object} customer - { thermostat_serial: string, service_address: string }
   * @returns {object[]} extracted signals
   */
  extractFromEcobeeReport(report, baseline, customer) {
    const signals = [];
    const T = this._t;

    // Parse rows into a usable structure
    // columns: date, hour, thermostat_identifier, [sensor data...]
    const rows = (report.rows ?? []).map(row => {
      const obj = {};
      (report.columns ?? []).forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });

    /** Alias for clarity in internal method signatures */
    const parsedRows = rows;

    if (rows.length === 0) return signals;

    // ── Short-cycling detection ────────────────────────────────────────────────
    const shortCycleSignals = this._detectShortCycling(parsedRows, T);
    signals.push(...shortCycleSignals);

    // ── Runtime anomaly ────────────────────────────────────────────────────────
    if (baseline?.avgRuntime) {
      const anomalySignals = this._detectRuntimeAnomaly(parsedRows, baseline, customer, T);
      signals.push(...anomalySignals);
    }

    // ── Failure to reach setpoint ──────────────────────────────────────────────
    const setpointSignals = this._detectSetpointFailure(parsedRows, T);
    signals.push(...setpointSignals);

    // ── Aux heat overshoot ─────────────────────────────────────────────────────
    const auxSignals = this._detectAuxHeatOvershoot(parsedRows, T);
    signals.push(...auxSignals);

    // ── Humidity elevation ─────────────────────────────────────────────────────
    const humiditySignals = this._detectHumidityElevation(parsedRows, T);
    signals.push(...humiditySignals);

    return signals;
  }

  /**
   * Short-cycling: compressor runs < SHORT_CYCLE_ON_MAX seconds,
   * followed by off-period < SHORT_CYCLE_OFF_MIN seconds.
   * Triggers when SHORT_CYCLE_COUNT_TRIGGER events occur within
   * SHORT_CYCLE_COUNT_WINDOW.
   */
  _detectShortCycling(parsedRows, T) {
    const signals = [];

    // Ecobee runtime has columns like:
    // coolStagingIndex, auxHeat1, auxHeat2, compassDirection, ...
    // Actual compressor runtime metrics: "compCool1" or "coolPump1" depending on firmware
    // We look for rows where runtime per 15-min slot is very low
    const runtimeCols = ['compCool1', 'coolPump1', 'compHeat1', 'heatPump1'];
    const availableCols = Object.keys(parsedRows[0] ?? {});

    // Find which runtime column is present
    const runtimeCol = runtimeCols.find(c => availableCols.includes(c)) ?? null;

    let shortCycleCount = 0;
    let shortCycleWindow = [];

    for (const row of parsedRows) {
      const runtimeSec = runtimeCol ? Number(row[runtimeCol] ?? 0) : 0;

      if (runtimeCol && runtimeSec < T.SHORT_CYCLE_ON_MAX / 4) {
        // Per 15-min slot: < 75 sec of runtime = likely short-cycling
        const ts = new Date(`${row.date}T${String(row.hour).padStart(2,'0')}:00:00`).getTime();
        shortCycleWindow.push(ts);
        shortCycleCount++;
      }
    }

    if (shortCycleWindow.length === 0) return signals;

    // Keep only events within the window — anchor to earliest event in this report
    const anchorTime = Math.min(...shortCycleWindow);
    const windowMs = T.SHORT_CYCLE_COUNT_WINDOW * 1000;
    shortCycleWindow = shortCycleWindow.filter(ts => anchorTime - ts < windowMs);

    if (shortCycleWindow.length >= T.SHORT_CYCLE_COUNT_TRIGGER) {
      signals.push({
        type:          SIGNAL_TYPES.SHORT_CYCLING,
        severity:      'elevated',
        trigger_count: shortCycleWindow.length,
        window_hours:  Math.round(T.SHORT_CYCLE_COUNT_WINDOW / 3600),
        message:       'Short-cycling detected: compressor is turning on and off repeatedly, which can indicate refrigerant issues, low airflow, or a failing compressor.',
        recommendation: 'Schedule a diagnostic visit to prevent compressor failure.',
      });
    }

    return signals;
  }

  /**
   * Runtime anomaly: current runtime significantly exceeds customer's baseline.
   */
  _detectRuntimeAnomaly(parsedRows, baseline, customer, T) {
    const signals = [];
    const runtimeCols = ['compCool1', 'coolPump1', 'compHeat1', 'heatPump1'];
    const availableCols = Object.keys(parsedRows[0] ?? {});
    const runtimeCol = runtimeCols.find(c => availableCols.includes(c));

    if (!runtimeCol) return signals;

    // Sum total runtime across all rows in this report
    const totalRuntime = parsedRows.reduce((sum, row) => sum + Number(row[runtimeCol] ?? 0), 0);
    const reportHours = parsedRows.length / 4; // rows are per 15-min slot
    const avgRuntimePerHour = reportHours > 0 ? totalRuntime / reportHours : 0;

    if (avgRuntimePerHour > baseline.avgRuntime * T.RUNTIME_ANOMALY_MULT) {
      signals.push({
        type:       SIGNAL_TYPES.RUNTIME_ANOMALY,
        severity:   'elevated',
        current_rph: Math.round(avgRuntimePerHour),
        baseline_rph: Math.round(baseline.avgRuntime),
        ratio:       (avgRuntimePerHour / baseline.avgRuntime).toFixed(1),
        message:    'System runtime is significantly higher than normal, which can indicate a efficiency drop, dirty filters, or a failing component.',
        recommendation: 'A technician should perform a performance check.',
      });
    }

    return signals;
  }

  /**
   * Failure to reach setpoint: indoor temperature stays > N degrees below
   * cooling setpoint (or above heating setpoint) for sustained period.
   */
  _detectSetpointFailure(parsedRows, T) {
    const signals = [];

    const tempCol = 'insideTemperature';
    const coolCol = 'cool1';
    const heatCol = 'heat1';
    const availableCols = Object.keys(parsedRows[0] ?? {});

    if (!availableCols.includes(tempCol)) return signals;

    let sustainedMinutes = 0;
    let maxDelta = 0;

    for (const row of parsedRows) {
      const temp = Number(row[tempCol] ?? 0);
      // Determine setpoint from active climate (cool1 or heat1 running)
      const coolingRunning = Number(row[coolCol] ?? 0) > 0;
      const heatingRunning = Number(row[heatCol] ?? 0) > 0;

      if (coolingRunning) {
        // House is ABOVE cooling setpoint — system struggling to cool
        const setpoint = Number(row['coolSetpoint'] ?? 76);
        const delta = temp - setpoint;
        if (delta >= T.SETPOINT_DELTA_TRIGGER) {
          sustainedMinutes += 15; // each row = 15 min
          maxDelta = Math.max(maxDelta, delta);
        }
      } else if (heatingRunning) {
        // House is BELOW heating setpoint — system struggling to heat
        const setpoint = Number(row['heatSetpoint'] ?? 70);
        const delta = setpoint - temp;
        if (delta >= T.SETPOINT_DELTA_TRIGGER) {
          sustainedMinutes += 15;
          maxDelta = Math.max(maxDelta, delta);
        }
      }
    }

    if (sustainedMinutes >= T.SETPOINT_SUSTAINED_MIN) {
      signals.push({
        type:              SIGNAL_TYPES.SETPOINT_FAILURE,
        severity:          'elevated',
        sustained_minutes: sustainedMinutes,
        max_delta_deg_f:   maxDelta,
        message:           `System is struggling to reach setpoint — temperature stayed ${maxDelta.toFixed(0)}°F above cooling setpoint for ${sustainedMinutes}+ minutes.`,
        recommendation:    'Schedule a service call to check refrigerant charge and airflow.',
      });
    }

    return signals;
  }

  /**
   * Aux heat overshoot: auxiliary heat running excessively relative to
   * primary heat pump runtime, indicating a failing reversing valve or
   * low refrigerant charge.
   */
  _detectAuxHeatOvershoot(parsedRows, T) {
    const signals = [];

    const auxCols = ['auxHeat1', 'auxHeat2', 'auxHeat3'];
    const heatCol = 'heatPump1';
    const availableCols = Object.keys(parsedRows[0] ?? {});
    const auxCol = auxCols.find(c => availableCols.includes(c));
    if (!auxCol || !availableCols.includes(heatCol)) return signals;

    let totalAuxSeconds = 0;
    let totalHeatSeconds = 0;

    for (const row of parsedRows) {
      totalAuxSeconds  += Number(row[auxCol] ?? 0);
      totalHeatSeconds += Number(row[heatCol] ?? 0);
    }

    if (totalHeatSeconds > 0) {
      const auxRatio = totalAuxSeconds / totalHeatSeconds;
      if (auxRatio > T.AUX_OVERRIDE_MULT && totalAuxSeconds > T.AUX_OVERSHOOT_TRIGGER) {
        signals.push({
          type:               SIGNAL_TYPES.AUX_HEAT_OVERSHOOT,
          severity:           'elevated',
          aux_runtime_hours:  (totalAuxSeconds / 3600).toFixed(1),
          heat_runtime_hours: (totalHeatSeconds / 3600).toFixed(1),
          aux_ratio:          auxRatio.toFixed(2),
          message:           `Auxiliary heat has run ${auxRatio.toFixed(1)}x the heat pump runtime — possible reversing valve issue or low refrigerant.`,
          recommendation:    'Schedule diagnostics before the reversing valve fails completely.',
        });
      }
    }

    return signals;
  }

  /**
   * Humidity elevation: relative humidity rising > N percentage points
   * over a 24-hour window.
   */
  _detectHumidityElevation(parsedRows, T) {
    const signals = [];

    const humCol = 'insideHumidity';
    const availableCols = Object.keys(parsedRows[0] ?? {});
    if (!availableCols.includes(humCol)) return signals;

    // Group rows by date — find earliest and latest reading per day
    const byDate = {};
    for (const row of parsedRows) {
      const date = row['date'];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(Number(row[humCol] ?? 0));
    }

    const dates = Object.keys(byDate).sort();
    if (dates.length < 2) return signals;

    // Compare earliest day avg vs latest day avg
    const earliestHum = byDate[dates[0]].reduce((a, b) => a + b, 0) / byDate[dates[0]].length;
    const latestHum   = byDate[dates[dates.length - 1]].reduce((a, b) => a + b, 0) / byDate[dates[dates.length - 1]].length;
    const rise = latestHum - earliestHum;

    if (rise >= T.HUMIDITY_RISE_TRIGGER) {
      signals.push({
        type:          SIGNAL_TYPES.HUMIDITY_ELEVATION,
        severity:      'info',
        rise_pct:      Math.round(rise),
        earliest_pct:   Math.round(earliestHum),
        latest_pct:    Math.round(latestHum),
        message:       `Humidity rose ${Math.round(rise)} percentage points over ${dates.length} days (${Math.round(earliestHum)}% → ${Math.round(latestHum)}%). This can strain cooling equipment.`,
        recommendation: 'Consider scheduling a ductwork inspection or UV light installation.',
      });
    }

    return signals;
  }

  /**
   * Convert a raw Ecobee webhook payload into a normalized structure.
   * Ecobee sends events in different formats depending on the notification type.
   */
  static normalizeWebhookPayload(payload) {
    const event = payload?.event ?? payload ?? {};
    return {
      thermostat_serial: event.thermostatIdentifier ?? event.thermostat_serial ?? '',
      event_type:        event.type ?? event.eventType ?? 'unknown',
      timestamp:         event.timestamp ?? event.date ?? new Date().toISOString(),
      runtime_report:    event.runtimeReport ?? event.runtime_report ?? null,
      alert:             event.alerts ? event.alerts[0] : (event.alert ?? null),
      telemetry: {
        temperature:  event.temperature ?? event.temp ?? null,
        humidity:     event.humidity ?? event.currenthumidity ?? null,
        setpoint:     event.setpoint ?? event.desiredHeat ?? null,
        hvac_mode:    event.hvacMode ?? event.mode ?? null,
        equipment_status: event.equipmentStatus ?? event.status ?? null,
      },
    };
  }
}

// ── Proactive Lead Generator ──────────────────────────────────────────────────

export class ProactiveLeadGenerator {
  /**
   * @param {object} opts
   * @param {object} opts.fsmAdapter    - FSM adapter for pushing leads
   * @param {object} opts.queueStore     - Queue store for logging
   * @param {string} opts.tenantId       - Tenant ID
   * @param {string} opts.tenantSlug    - Tenant slug
   * @param {Function} opts.logger      - Logger function
   */
  constructor(opts) {
    this._fsm    = opts.fsmAdapter;
    this._queue  = opts.queueStore;
    this._tid    = opts.tenantId;
    this._tslug  = opts.tenantSlug;
    this._log    = opts.logger ?? (() => {});
  }

  /**
   * Generate a proactive service lead from a thermostat signal.
   * @param {object} signal     - extracted signal
   * @param {object} customer  - { phone, name, address, thermostat_serial }
   * @returns {Promise<string>}  queue entry id
   */
  async generateLead(signal, customer) {
    const { type, severity, message, recommendation } = signal;

    const serviceAddress = customer.service_address ?? customer.address ?? 'Unknown Address';
    const phone = customer.phone ?? '';

    // Build a synthetic message that mirrors what the customer would text
    const syntheticMessage = `[IoT Alert] Your HVAC system flagged: ${message} ${recommendation}`;

    this._log(`[ProactiveLead] Generating lead for ${phone} — signal: ${type}, severity: ${severity}`);

    // Enqueue in the unified queue as a proactive outreach entry
    const entryId = await this._queue.enqueue({
      tenantId:   this._tid,
      tenantSlug: this._tslug,
      channel:   'iot',
      direction:  'inbound',
      rawInput:  syntheticMessage,
      status:    'proactive_outreach',
      priority:  severity === 'elevated' ? 'high' : 'normal',
      flags:     { signal_type: type, proactive: true, iot_source: 'thermostat' },
      classification: {
        intent:           'proactive_service',
        urgency:          severity === 'elevated' ? 'urgent' : 'routine',
        signal_type:      type,
        equipment_type:   'thermostat',
        proactive:        true,
        recommendation,
      },
    });

    // If FSM adapter is available, also push as a lead
    if (this._fsm) {
      try {
        const customerId = await this._fsm.upsertCustomer({
          phone,
          name:    customer.name ?? 'Thermostat Customer',
          address: serviceAddress,
        });

        const jobId = await this._fsm.createJob({
          customerId,
          title:   `Proactive: ${type.replace(/_/g, ' ')}`,
          notes:   `${message}\n\nRecommendation: ${recommendation}\n\nSignal data: ${JSON.stringify(signal)}`,
          jobType: 'diagnostic',
          priority: severity === 'elevated' ? 'high' : 'normal',
          propertyAddress: serviceAddress,
        });

        await this._queue.updateEntry(entryId, { flags: { ...(await this._queue.getEntry(entryId)).flags, fsm_job_id: jobId } });
        this._log(`[ProactiveLead] FSM job created: ${jobId}`);
      } catch (err) {
        this._log(`[ProactiveLead] FSM push failed: ${err.message} — queue entry still created: ${entryId}`);
      }
    }

    return entryId;
  }
}
