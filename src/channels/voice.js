/**
 * Twilio Voice Webhook — /webhooks/voice
 *
 * Two-stage voice handling:
 *   Stage 1 (CIPA): Play disclosure, then redirect to Stage 2
 *   Stage 2: Route to conversational core / dispatcher
 *
 * Twilio POST fields:
 *   From, To, CallSid, CallStatus, Digits, RecordingUrl, etc.
 */

import twilio from 'twilio';
import { scan }             from '../lib/safety-gate.js';
import { makeDispatcherNotifier } from '../lib/dispatcher.js';
import { processMessage }   from '../conversation/orchestrator.js';
import { enqueue, updateEntry, QUEUE_STATUS } from '../queue/store.js';
import { logger }           from '../utils/logger.js';
import {
  buildCipaCompliantVoiceTwiml,
  buildCipaTwiml,
  consentStore,
  CONSENT_TYPES,
} from '../compliance/consent-store.js';
import { resolveTenant } from '../multi-tenant/router.js';

// ── Signature validation ───────────────────────────────────────────────────────

function isValidTwilioRequest(req, tenant) {
  const authToken = tenant?.channels?.twilio?.authToken
    ?? process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.warn('TWILIO_AUTH_TOKEN not set — skipping voice signature validation');
    return true;
  }
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  return twilio.validateRequest(
    authToken,
    signature,
    `${process.env.BASE_URL}/webhooks/voice`,
    req.method === 'POST' ? req.body : {}
  );
}

// ── TCPA consent helpers ───────────────────────────────────────────────────────

/**
 * Quick check if caller has active voice consent.
 * In production: look up by caller phone or customer_id from FSM.
 */
function hasVoiceConsent(phone) {
  // TODO: resolve customer_id from FSM by phone
  // For now: check if any consent record exists for this phone
  // (consentStore is keyed by customerId, not phone)
  // In prod, you'd look up customerId first, then check.
  return true; // permissive until FSM integration is wired
}

// ── Stage 1: CIPA Disclosure ──────────────────────────────────────────────────

/**
 * GET|POST /webhooks/voice
 *
 * Twilio calls this on inbound voice. If CallStatus = 'ringing' or
 * 'in-progress' and this is the first hit, play CIPA disclosure.
 * Otherwise treat as Stage 2 redirect target.
 */
async function handleVoiceInbound(req, res) {
  // Multi-tenant: resolved by tenantMiddleware in app.js
  const tenant    = req.tenant ?? { id: process.env.DEFAULT_TENANT_ID ?? 'default', slug: process.env.DEFAULT_TENANT_SLUG ?? 'default' };
  const tenantId = tenant.id;

  if (!isValidTwilioRequest(req, tenant)) {
    logger.warn('Rejected invalid voice signature', { ip: req.ip });
    return res.status(403).send('Forbidden');
  }

  const {
    From:          fromPhone,
    To:            toPhone,
    CallSid:       callSid,
    CallStatus:    callStatus,
    Digits:        digits,
    FromCity,
    FromState,
    FromCountry,
  } = req.body;

  // ── Stage 1: CIPA disclosure for ringing/in-progress calls ────────────────
  // If this is a fresh inbound call (not a redirect from the disclosure),
  // play the CIPA disclosure and redirect to the same URL for Stage 2.
  if (callStatus === 'ringing' || callStatus === 'initiated') {
    logger.info('Voice inbound — playing CIPA disclosure', { callSid, from: fromPhone });

    // Build CIPA disclosure TwiML
    // After the disclosure, redirect back to this same URL so Stage 2 handles the call
    const nextUrl = `${process.env.BASE_URL}/webhooks/voice`;

    const twiml = buildCipaCompliantVoiceTwiml({ nextUrl });

    // Record that CIPA disclosure was presented (voice consent for AI analysis)
    // We use the caller's phone as a temporary identifier until FSM resolves customer_id
    try {
      recordCipaConsentByPhone(fromPhone, tenantId, { source: 'verbal' });
    } catch (err) {
      logger.warn('[VoiceWebhook] Failed to record CIPA consent', { error: err.message });
    }

    return res.status(200)
      .set('Content-Type', 'text/xml')
      .send(twiml);
  }

  // ── Stage 2: Post-disclosure call handling ────────────────────────────────
  logger.info('Voice inbound — Stage 2', { callSid, from: fromPhone, callStatus });

  // Record call in queue
  const entry = enqueue({
    channel:         'voice',
    tenant_id:        tenantId,
    raw_input:        `Voice call from ${fromPhone}`,
    transcript:      null,
    caller_phone:     fromPhone ?? null,
    service_address: null,
    contact_name:    null,
    direction:      'inbound',
  });

  // Check consent
  const canProceed = hasVoiceConsent(fromPhone);
  if (!canProceed) {
    updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED });
    logger.audit('voice_blocked_no_consent', { entryId: entry.id, from: fromPhone });
    return res.status(200)
      .set('Content-Type', 'text/xml')
      .send(voiceBlockTwiml());
  }

  // Run safety gate on any DTMF input or spoken content
  // (For voice, the main intake happens via the conversational core)
  let safetyResult;
  try {
    safetyResult = await scan(`Voice call from ${fromPhone}`, {
      channel:   'voice',
      tenantId,
      messageId: callSid,
      logFn: (e) => logger.audit('safety_gate', e),
      notifyDispatcherFn: makeDispatcherNotifier({ logFn: (e) => logger.audit('dispatcher', e), dispatcherPhone: tenant.dispatcher }),
    });
  } catch {
    safetyResult = { pass: true, triggers: [], severity: 'low' };
  }

  updateEntry(entry.id, {
    safety_gate_passed: safetyResult.pass,
    safety_gate_result: safetyResult.triggers.length > 0
      ? { triggered: true, triggers: safetyResult.triggers, severity: safetyResult.severity }
      : { triggered: false },
  });

  if (!safetyResult.pass) {
    updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED });
    logger.audit('voice_escalated', { entryId: entry.id });
    return res.status(200)
      .set('Content-Type', 'text/xml')
      .send(voiceEscalationTwiml(safetyResult.response));
  }

  // Mark as qualified and proceed to call flow
  updateEntry(entry.id, { status: QUEUE_STATUS.QUALIFIED });

  // Transfer to dispatcher / IVR — now uses open speech prompt
  return res.status(200)
    .set('Content-Type', 'text/xml')
    .send(voiceOpenPromptTwiml());
}

// ── CIPA consent recording ─────────────────────────────────────────────────────

/**
 * Record CIPA disclosure consent, using phone as a temporary identifier.
 * In production: look up the customer_id from FSM first.
 */
function recordCipaConsentByPhone(phone, tenantId, meta = {}) {
  // In production: resolve customerId from FSM by phone number
  // For now, use phone as a synthetic customerId
  const customerId = `voice_${phone}`;
  consentStore.grant({
    customerId,
    channel:     'voice',
    consentType: CONSENT_TYPES.AI_ANALYSIS,
    scope:       'Voice call CIPA disclosure',
    source:      meta.source ?? 'verbal',
  });
}

// ── TwiML builders ─────────────────────────────────────────────────────────────

/**
 * TwiML for blocked calls (no consent)
 */
function voiceBlockTwiml() {
  return `<Response>
    <Say voice="Polly.Joanna">
      We're sorry, but we do not have your consent to handle this call.
      Please contact us directly or visit our website for assistance.
    </Say>
    <Hangup/>
  </Response>`;
}

/**
 * TwiML for escalated voice calls (safety gate fail).
 * @param {string} message
 * @param {string} [dispatcherPhone] — tenant's dispatcher number; falls back to env var
 */
function voiceEscalationTwiml(message, dispatcherPhone) {
  const phone = dispatcherPhone || process.env.DISPATCHER_PHONE || '';
  const baseUrl = process.env.BASE_URL || '';
  return `<Response>
    <Say voice="Polly.Joanna">
      ${message ?? 'Please hold while we connect you with a representative.'}
    </Say>
    <Dial timeout="30" action="${baseUrl}/webhooks/voice/status">
      <Number statusCallbackEvent="initiated completed" statusCallback="${baseUrl}/webhooks/voice/status">
        ${phone}
      </Number>
    </Dial>
  </Response>`;
}

/**
 * DTMF fallback menu — used only when the speech prompt times out or
 * the caller presses a digit without speaking.
 */
function voiceMainMenuTwiml() {
  return `<Response>
    <Say voice="Polly.Joanna">
      Thank you for calling. How can we help you today?
      Press one to schedule a service appointment.
      Press two for a price estimate or quote.
      Press three for billing or account questions.
      Or simply state your question and a technician will follow up by phone or text.
    </Say>
    <Gather numDigits="1" timeout="10" action="/webhooks/voice/gather" method="POST">
      <Say voice="Polly.Joanna">Press one, two, or three, or wait on the line.</Say>
    </Gather>
    <Say voice="Polly.Joanna">No response received. A technician will follow up shortly. Goodbye.</Say>
    <Hangup/>
  </Response>`;
}

/**
 * Open prompt TwiML — asks an open question and listens for speech (or DTMF).
 * Used in Stage 2 to replace the DTMF-only menu.
 */
function voiceOpenPromptTwiml() {
  return `<Response>
    <Gather input="speech dtmf" numDigits="1" speechTimeout="auto" action="/webhooks/voice/speech" method="POST"
            hints="gas leak, carbon monoxide, smoke, burning smell, no heat, no cooling, water leak, furnace, air conditioner, thermostat, schedule, appointment, price, estimate">
      <Say voice="Polly.Joanna">
        Thanks for calling. Tell me what's going with your HVAC system —
        or press 1 to schedule service, 2 for a price estimate, or 3 for billing.
      </Say>
    </Gather>
    <Say voice="Polly.Joanna">No response received. A technician will follow up shortly. Goodbye.</Say>
    <Hangup/>
  </Response>`;
}

/**
 * Handle speech-to-text result from Twilio <Gather input="speech">.
 * Routes the caller's spoken words through Layer 0 (safety gate) and
 * Layer 2 (orchestrator) — the same pipeline SMS and web chat use.
 */
async function handleVoiceSpeech(req, res) {
  if (process.env.BYPASS_TWILIO_SIGNATURE !== 'true' && !isValidTwilioRequest(req)) {
    return res.status(403).send('Forbidden');
  }

  const { SpeechResult, Digits, CallSid, From: fromPhone } = req.body;
  const tenantId = process.env.DEFAULT_TENANT_ID ?? 'default';

  // Digit pressed with no speech — fall back to DTMF menu
  if (!SpeechResult && Digits) {
    return handleVoiceGather(req, res);
  }

  // Nothing captured — replay the open prompt
  if (!SpeechResult) {
    return res.status(200).set('Content-Type', 'text/xml').send(voiceOpenPromptTwiml());
  }

  const { tenant: resolvedTenant } = resolveTenant(req);
  const tenant = resolvedTenant ?? { id: tenantId, dispatcher: process.env.DISPATCHER_PHONE ?? null };

  const entry = enqueue({
    channel:       'voice',
    tenant_id:     tenantId,
    raw_input:     SpeechResult,
    transcript:   SpeechResult,
    caller_phone: fromPhone ?? null,
    direction:    'inbound',
  });

  // ── Layer 0: safety gate against actual spoken words ─────────────────────────
  let safetyResult;
  try {
    safetyResult = await scan(SpeechResult, {
      channel:    'voice',
      tenantId,
      messageId:  CallSid,
      logFn:     (e) => logger.audit('safety_gate', e),
      notifyDispatcherFn: makeDispatcherNotifier({ logFn: (e) => logger.audit('dispatcher', e), dispatcherPhone: tenant.dispatcher }),
    });
  } catch {
    safetyResult = { pass: true, triggers: [], severity: 'low' };
  }

  updateEntry(entry.id, {
    safety_gate_passed: safetyResult.pass,
    safety_gate_result: safetyResult.triggers.length > 0
      ? { triggered: true, triggers: safetyResult.triggers, severity: safetyResult.severity }
      : { triggered: false },
  });

  if (!safetyResult.pass) {
    updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED });
    logger.audit('voice_escalated', { entryId: entry.id, transcript: SpeechResult });
    return res.status(200).set('Content-Type', 'text/xml').send(voiceEscalationTwiml(safetyResult.response, tenant.dispatcher));
  }

  // ── Layer 2: conversational core ────────────────────────────────────────────
  let outbound;
  try {
    outbound = await processMessage(SpeechResult, fromPhone ?? 'unknown', tenantId, null, entry.id);
    updateEntry(entry.id, { llm_classification: outbound.classification, status: QUEUE_STATUS.QUALIFIED });
  } catch (err) {
    logger.error('Voice Layer 2 failed', { error: err.message });
    outbound = { text: 'Thanks — a technician will follow up with you shortly.' };
  }

  return res.status(200).set('Content-Type', 'text/xml').send(
    `<Response><Say voice="Polly.Joanna">${outbound.text}</Say><Hangup/></Response>`
  );
}

/**
 * Handle Gather result (DTMF pressed after main menu)
 */
async function handleVoiceGather(req, res) {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');

  const { Digits, CallSid } = req.body;

  if (!Digits) {
    return res.status(200).set('Content-Type', 'text/xml').send(voiceMainMenuTwiml());
  }

  const { tenant: tenant2 } = resolveTenant(req);
  const tenantId = (tenant2 ?? { id: process.env.DEFAULT_TENANT_ID ?? 'default' }).id;
  const entry = enqueue({
    channel:         'voice',
    direction:      'inbound',
    tenant_id:        tenantId,
    raw_input:        `Voice menu: pressed ${Digits}`,
    transcript:      null,
    caller_phone:     req.body.From ?? null,
  });
  updateEntry(entry.id, { status: QUEUE_STATUS.QUALIFIED });

  switch (Digits) {
    case '1':
      return res.status(200).set('Content-Type', 'text/xml').send(
        `<Response><Say voice="Polly.Joanna">Scheduling a service appointment. Our team will call you back within one business day to confirm your appointment.</Say><Hangup/></Response>`
      );
    case '2':
      return res.status(200).set('Content-Type', 'text/xml').send(
        `<Response><Say voice="Polly.Joanna">For a price estimate, please visit our website or send us a text message. A technician will follow up with a quote within a few hours.</Say><Hangup/></Response>`
      );
    case '3':
      return res.status(200).set('Content-Type', 'text/xml').send(
        `<Response><Say voice="Polly.Joanna">Billing and account questions. Our team will follow up with you shortly.</Say><Hangup/></Response>`
      );
    default:
      return res.status(200).set('Content-Type', 'text/xml').send(voiceMainMenuTwiml());
  }
}

/**
 * Call status callback — log call outcome
 */
async function handleVoiceStatus(req, res) {
  const { CallSid, CallStatus } = req.body;
  logger.info('Voice call status', { callSid, status: CallStatus });
  return res.status(200).send('');
}

// ── Route registration ──────────────────────────────────────────────────────────

export async function registerVoiceRoutes(app) {
  const { Router } = await import('express');
  const r = Router();

  r.post('/webhooks/voice',         handleVoiceInbound);
  r.post('/webhooks/voice/gather',  handleVoiceGather);
  r.post('/webhooks/voice/speech',  handleVoiceSpeech);
  r.post('/webhooks/voice/status',   handleVoiceStatus);

  app.use(r);
}
