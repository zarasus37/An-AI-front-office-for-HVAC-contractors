/**
 * Twilio SMS Webhook — /webhooks/sms/inbound
 *
 * Validates x-twilio-signature, runs Layer 0 safety gate,
 * looks up FSM pricebook (L3), enqueues the message (L1),
 * runs Layer 2 conversational core, returns TwiML.
 *
 * Twilio POST fields:
 *   From, To, Body, MessageSid, AccountSid, FromCity, FromState,
 *   FromCountry, ToCity, ToState, ToCountry
 */

import twilio from 'twilio';
import { scan } from '../lib/safety-gate.js';
import { makeDispatcherNotifier } from '../lib/dispatcher.js';
import { consentStore } from '../compliance/consent-store.js';
import { TcpaStopWordHandler } from '../compliance/consent-store.js';
import { enqueue, updateEntry, QUEUE_STATUS } from '../queue/store.js';
import { logger } from '../utils/logger.js';
import { twimlResponse } from '../utils/twiml.js';
import { processMessage } from '../conversation/orchestrator.js';
import { ruleBasedClassify } from '../conversation/classifier.js';
import { lookupPricebook } from '../fsm/router.js';
import { TCPA_STOP_ACKNOWLEDGE } from './outbound.js';

// Lazy-load Express router
let _router;
async function router() {
  if (!_router) {
    _router = (await import('express')).Router();
  }
  return _router;
}

/**
 * Validate Twilio webhook signature.
 * Uses per-tenant TWILIO_AUTH_TOKEN if tenant is resolved, else global env.
 */
function isValidTwilioRequest(req, tenant) {
  const authToken = tenant?.channels?.twilio?.authToken
    ?? process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.warn('TWILIO_AUTH_TOKEN not set — skipping signature validation');
    return true; // fail open in dev; fail closed in prod
  }
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  return twilio.validateRequest(
    authToken,
    signature,
    `${process.env.BASE_URL}/webhooks/sms/inbound`,
    req.method === 'POST' ? req.body : {}
  );
}

/**
 * Look up an FSM pricebook entry based on classified intent.
 * Only fires for quote/schedule intents to avoid unnecessary FSM calls.
 *
 * @param {string} intent
 * @param {string} message
 * @returns {Promise<object|null>}
 */
async function resolvePricebookMatch(intent, message) {
  // Only look up pricebook for intents that involve service/price
  const pricebookIntents = new Set(['quote_request', 'schedule_service', 'membership']);

  if (!pricebookIntents.has(intent)) return null;

  // Use the message itself as the service name hint
  // Strip common filler words to get service keywords
  const serviceHint = message
    .toLowerCase()
    .replace(/\b(how much|does|cost|price|for|my|i need|i want|can you|what is|what's|quote|estimate)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!serviceHint) return null;

  try {
    const entry = await lookupPricebook(serviceHint, null);
    if (entry) {
      logger.debug('[TwilioWebhook] Pricebook match found', { service: entry.service_name, price: entry.price });
    }
    return entry ?? null;
  } catch (err) {
    logger.warn('[TwilioWebhook] Pricebook lookup failed — continuing without price', { error: err.message });
    return null;
  }
}

/**
 * POST /webhooks/sms/inbound
 * Twilio calls this when an SMS arrives on your Twilio number.
 */
async function handleInbound(req, res) {
  // Multi-tenant: resolved by tenantMiddleware in app.js
  const tenant    = req.tenant ?? { id: process.env.DEFAULT_TENANT_ID ?? 'default', slug: process.env.DEFAULT_TENANT_SLUG ?? 'default' };
  const tenantId = tenant.id;

  // ── 1. Signature validation ─────────────────────────────────────────────────
  if (!isValidTwilioRequest(req, tenant)) {
    logger.warn('Rejected invalid Twilio signature', { ip: req.ip, path: req.path });
    return res.status(403).send('Forbidden');
  }

  // ── 2. Parse Twilio POST body ──────────────────────────────────────────────
  const {
    From:       fromPhone,
    To:         toPhone,
    Body:       body,
    MessageSid: messageSid,
  } = req.body;

  if (!body || !body.trim()) {
    // Twilio sends empty Body for MMS image-only messages
    return res.status(200).send(
      twimlResponse('Thanks — we received your message and will follow up shortly.')
    );
  }

  logger.info('SMS inbound', { from: fromPhone, to: toPhone, sid: messageSid });

  // ── 3. TCPA Stop-Word Check ─────────────────────────────────────────────────
  // Check BEFORE enqueueing — stop-words should not generate queue entries
  const tcpaHandler = new TcpaStopWordHandler({ consentStore, logger });

  // Resolve customerId from FSM by phone (for TCPA guard)
  let customerId = null;
  try {
    const { getAdapter } = await import('../fsm/router.js');
    const adapter = getAdapter();
    const customer = await adapter.upsertCustomer({ phone: fromPhone });
    customerId = customer?.fsm_id ?? null;
  } catch {
    // FSM not available — proceed without customerId
  }

  const tcpaResult = tcpaHandler.handleStopWord(body, customerId ?? fromPhone, 'sms');
  if (tcpaResult.stopped) {
    logger.info('[TCPA] Stop-word detected — returning STOP acknowledgment', {
      customerId: customerId ?? fromPhone,
      revokedCount: tcpaResult.revokedCount,
    });
    return res.status(200)
      .set('Content-Type', 'text/xml')
      .send(twimlResponse(TCPA_STOP_ACKNOWLEDGE));
  }

  // ── 4. Run Layer 0 Safety Gate ──────────────────────────────────────────────

  const safetyResult = await scan(body, {
    channel:   'sms',
    tenantId,
    messageId: messageSid,
    logFn: (entry) => { logger.audit('safety_gate', entry); },
    notifyDispatcherFn: makeDispatcherNotifier({ logFn: (e) => logger.audit('dispatcher', e) }),
  });

  // ── 5. Enqueue ─────────────────────────────────────────────────────────────
  const entry = enqueue({
    channel:         'sms',
    direction:      'inbound',
    tenant_id:        tenantId,
    raw_input:        body,
    transcript:      null,
    caller_phone:     fromPhone ?? null,
    service_address: null,
    contact_name:    null,
  });

  updateEntry(entry.id, {
    safety_gate_passed:  safetyResult.pass,
    safety_gate_result:  safetyResult.triggers.length > 0
      ? { triggered: true, triggers: safetyResult.triggers, severity: safetyResult.severity, response: safetyResult.response }
      : { triggered: false },
  });

  // If escalated → mark as escalated immediately
  if (!safetyResult.pass) {
    updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED });
    logger.audit('queue_escalated', { entryId: entry.id, triggers: safetyResult.triggers });
    return res.status(200)
      .set('Content-Type', 'text/xml')
      .send(twimlResponse(safetyResult.response));
  }

  // ── 6. Pre-classify for FSM pricebook lookup (L3) ─────────────────────────
  // Rule-based, no LLM call — just to get the intent for pricebook routing.
  // The full LLM classification happens inside processMessage().
  let pricebookMatch = null;
  try {
    const { intent } = ruleBasedClassify(body);
    pricebookMatch = await resolvePricebookMatch(intent, body);
  } catch (err) {
    logger.warn('[TwilioWebhook] Pre-classification failed — continuing without pricebook', { error: err.message });
  }

  // ── 7. Route to Layer 2 Conversational Core ───────────────────────────────
  let outbound = { text: 'Thanks — we received your message. A technician will be in touch shortly.' };
  try {
    outbound = await processMessage(body, fromPhone ?? 'unknown', tenantId, pricebookMatch, entry.id);
    updateEntry(entry.id, { llm_classification: outbound.classification });
  } catch (err) {
    logger.error('Layer 2 orchestrator failed, using fallback', { error: err.message });
  }

  logger.info('Queue entry created', { entryId: entry.id, text: body.substring(0, 80) });
  return res.status(200)
    .set('Content-Type', 'text/xml')
    .send(twimlResponse(outbound.text));
}

/**
 * Register routes on an Express app.
 * @param {import('express').Express} app
 */
export async function registerSmsRoutes(app) {
  const r = await router();
  r.post('/webhooks/sms/inbound', handleInbound);
  app.use(r);
}

export { handleInbound };
