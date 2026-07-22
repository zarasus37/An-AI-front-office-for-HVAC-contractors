/**
 * Ecobee Webhook Handler — Layer 4 IoT
 *
 * POST /webhooks/ecobee
 * Ecobee sends webhook payloads to this endpoint on thermostat events.
 *
 * Flow:
 *   1. Verify HMAC-SHA256 signature
 *   2. Parse + normalize payload
 *   3. Resolve customer by thermostat serial
 *   4. Check THERMOSTAT_TELEMETRY consent (L6 consentStore)
 *   5. Extract signals (ThermostatSignalExtractor)
 *   6. Generate proactive leads (ProactiveLeadGenerator)
 *   7. Enqueue outbound SMS notification to customer
 *   8. Push IoT signal as session message for conversational follow-up
 *
 * Env vars:
 *   ECOBEE_CONSUMER_SECRET   — app consumer secret from Ecobee developer portal
 *   ECOBEE_WEBHOOK_BASE_URL  — public base URL for signature verification
 *   ECOBEE_VERIFY_SIGNATURE  — 'false' to skip verification (dev only)
 *   IOT_ENABLED              — 'true' to enable processing
 *   DEFAULT_TENANT_ID
 *   DEFAULT_TENANT_SLUG
 *   OUTBOUND_ENABLED         — 'true' to send proactive SMS to customer
 */

import { ThermostatSignalExtractor, ProactiveLeadGenerator } from './thermostat.js';
import { getCustomerByThermostat } from './customer-registry.js';
import { consentStore, CONSENT_TYPES } from '../compliance/consent-store.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} deps
 * @param {object} deps.fsmAdapter
 * @param {object} deps.queueStore
 * @param {object} deps.sessionStore  — session store for pushMessage / getSession
 * @param {Function} deps.logger
 */
export async function handleEcobeeWebhook(req, res, { fsmAdapter, queueStore, sessionStore, logger }) {
  const log = logger ?? (() => {});

  // ── 1. Signature Verification ──────────────────────────────────────────────
  const signature = req.header('x-ecobee-signature') ?? '';
  const baseUrl   = process.env.ECOBEE_WEBHOOK_BASE_URL ?? 'https://placeholder';
  const url       = `${baseUrl}${req.originalUrl ?? req.url ?? ''}`;
  const body      = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  if (process.env.ECOBEE_VERIFY_SIGNATURE !== 'false') {
    const secret = process.env.ECOBEE_CONSUMER_SECRET;
    if (!secret) {
      log('[EcobeeWebhook] ECOBEE_CONSUMER_SECRET not set — rejecting');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    const valid = ThermostatSignalExtractor.verifyEcobeeSignature(signature, url, body, secret);
    if (!valid) {
      log('[EcobeeWebhook] Invalid signature — rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // ── 2. Parse payload ───────────────────────────────────────────────────────
  const payload = ThermostatSignalExtractor.normalizeWebhookPayload(req.body);
  log(`[EcobeeWebhook] event=${payload.event_type} serial=${payload.thermostat_serial}`);

  if (!payload.thermostat_serial) {
    return res.status(400).json({ error: 'Missing thermostat_serial' });
  }

  // ── 3. IoT enabled check ──────────────────────────────────────────────────
  if (process.env.IOT_ENABLED !== 'true') {
    log('[EcobeeWebhook] IOT_ENABLED != true — acknowledged but not processing');
    return res.status(200).json({ status: 'ok', processed: false, reason: 'iot_disabled' });
  }

  // ── 4. Resolve customer by thermostat serial ────────────────────────────────
  const customer = getCustomerByThermostat(payload.thermostat_serial);
  if (!customer) {
    log(`[EcobeeWebhook] No customer mapped to thermostat ${payload.thermostat_serial}`);
    return res.status(200).json({ status: 'ok', processed: false, reason: 'no_customer_mapping' });
  }

  // ── 5. Consent check (L6) ─────────────────────────────────────────────────
  if (!consentStore.hasConsent(customer.customer_id, { consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY })) {
    log(`[EcobeeWebhook] Customer ${customer.customer_id} lacks THERMOSTAT_TELEMETRY consent — skipping`);
    return res.status(200).json({ status: 'ok', processed: false, reason: 'no_consent' });
  }

  // ── 6. Extract signals ─────────────────────────────────────────────────────
  const extractor = new ThermostatSignalExtractor({ logger: log });

  let signals = [];
  if (payload.runtime_report) {
    signals = extractor.extractFromEcobeeReport(
      payload.runtime_report,
      customer.baseline ?? {},
      customer,
    );
  } else if (payload.alert) {
    signals = extractor.extractFromAlert(payload.alert, customer);
  }

  if (signals.length === 0) {
    return res.status(200).json({ status: 'ok', processed: false, reason: 'no_signals' });
  }

  log(`[EcobeeWebhook] ${signals.length} signal(s) extracted: ${signals.map(s => s.type).join(', ')}`);

  // ── 7. Generate proactive leads ───────────────────────────────────────────
  const leadGen = new ProactiveLeadGenerator({
    fsmAdapter,
    queueStore,
    tenantId:   process.env.DEFAULT_TENANT_ID ?? 'default',
    tenantSlug: process.env.DEFAULT_TENANT_SLUG ?? 'default',
    logger:     log,
  });

  const leadResults = [];
  for (const signal of signals) {
    try {
      const entryId = await leadGen.generateLead(signal, customer);
      leadResults.push({ signal: signal.type, entryId, status: 'queued' });

      // ── 8. Push signal into conversation session for L2 follow-up ─────────
      if (sessionStore) {
        try {
          const { getSession, pushMessage, setClassification } = sessionStore;
          const session = getSession(customer.phone, process.env.DEFAULT_TENANT_ID ?? 'default');

          // Only create session entry if session exists or we create a new one
          if (session || customer.phone) {
            const signalMsg = `[IoT Alert] HVAC system event detected: ${signal.message}`;
            if (sessionStore.pushMessage) sessionStore.pushMessage(customer.phone, 'system', signalMsg);
            if (sessionStore.setClassification) {
              sessionStore.setClassification(customer.phone, {
                intent:           'proactive_service',
                urgency:          signal.severity === 'elevated' ? 'urgent' : 'routine',
                signal_type:      signal.type,
                proactive:        true,
                source:           'thermostat',
                recommendation:   signal.recommendation,
              });
            }
          }
        } catch (sErr) {
          log(`[EcobeeWebhook] Session push failed: ${sErr.message} — continuing`);
        }
      }

      // ── 9. Enqueue proactive outbound SMS notification ────────────────────
      if (process.env.OUTBOUND_ENABLED === 'true' && queueStore) {
        try {
          const smsText = buildProactiveSms(signal, customer);
          // Use queue schema snake_case field names
          queueStore.enqueue({
            tenant_id:   process.env.DEFAULT_TENANT_ID ?? 'default',
            tenant_slug: process.env.DEFAULT_TENANT_SLUG ?? 'default',
            channel:     'sms',
            direction:  'outbound',
            raw_input:   smsText,
            caller_phone: customer.phone,
            status:     'pending',
            priority:   signal.severity === 'elevated' ? 'high' : 'normal',
            flags: {
              proactive:          true,
              signal_type:        signal.type,
              outbound_mode:     'proactive_alert',
              iot_source:         'thermostat',
              thermostat_serial:  payload.thermostat_serial,
            },
          });
          log(`[EcobeeWebhook] Outbound SMS enqueued for ${customer.phone}: ${signal.type}`);
        } catch (qErr) {
          log(`[EcobeeWebhook] Outbound SMS enqueue failed: ${qErr.message}`);
        }
      }
    } catch (err) {
      log(`[EcobeeWebhook] Lead generation failed for ${signal.type}: ${err.message}`);
      leadResults.push({ signal: signal.type, error: err.message });
    }
  }

  return res.status(200).json({
    status:    'ok',
    processed: true,
    signals:   leadResults,
    count:     leadResults.length,
  });
}

/**
 * Build a proactive SMS alert from a signal.
 * Keeps message under 160 chars for single-segment SMS.
 *
 * @param {object} signal
 * @param {object} customer
 * @returns {string}
 */
function buildProactiveSms(signal, customer) {
  const shortMap = {
    short_cycling:      'short-cycling',
    runtime_anomaly:    'unusual runtime',
    setpoint_failure:   'setpoint issue',
    aux_heat_overshoot: 'aux heat alert',
    humidity_elevation:  'humidity alert',
    filter_timer:       'filter reminder',
    overnight_run:      'overnight run',
    recovery_lag:       'recovery lag',
  };

  const label = shortMap[signal.type] ?? signal.type.replace(/_/g, ' ');
  const action = signal.recommendation
    ? ` ${signal.recommendation.substring(0, 60).trimEnd()}...`
    : ' A technician will follow up with details.';

  return `HVAC Alert${action}`;
}
