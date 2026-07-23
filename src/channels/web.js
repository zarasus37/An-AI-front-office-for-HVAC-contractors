/**
 * Web Chat Channel — /web/chat
 *
 * Provides a JSON REST endpoint for a web chat widget.
 * Unlike Twilio (TwiML), this is a plain JSON API — no webhook signature validation.
 *
 * The widget POSTs here; the server processes through L0 → L2 and returns JSON.
 */

import { scan } from '../lib/safety-gate.js';
import { makeDispatcherNotifier } from '../lib/dispatcher.js';
import { consentStore } from '../compliance/consent-store.js';
import { TcpaStopWordHandler } from '../compliance/consent-store.js';
import { enqueue, updateEntry, QUEUE_STATUS } from '../queue/store.js';
import { logger as appLogger } from '../utils/logger.js';
import { processMessage } from '../conversation/orchestrator.js';
import { ruleBasedClassify } from '../conversation/classifier.js';
import { lookupPricebook } from '../fsm/router.js';

// ── Web chat response helpers ──────────────────────────────────────────────────

/**
 * Build a JSON response (not TwiML).
 */
function json(res, data, status = 200) {
  res.status(status).set('Content-Type', 'application/json').json(data);
}

/**
 * Map classification intent → suggested quick replies for the web UI.
 */
function quickRepliesForIntent(intent) {
  switch (intent) {
    case 'schedule_service':  return ['Schedule a visit', 'Get a quote', 'Check pricing'];
    case 'quote_request':     return ['See our prices', 'Maintenance plans', 'Talk to a tech'];
    case 'membership':        return ['View plans', 'Compare coverage', 'Get pricing'];
    case 'emergency':         return ['Call now', 'Get help fast', 'Safety tips'];
    default:                  return ['Yes, continue', 'Talk to support', 'Call me back'];
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * POST /web/chat — submit a web chat message
 *
 * Body: { sessionId?, message, name?, email?, address? }
 * Returns: { text, classification, suggestions, sessionId }
 */
async function handleChat(req, res) {
  // Multi-tenant: resolved by tenantMiddleware in app.js
  const tenant    = req.tenant ?? { id: process.env.DEFAULT_TENANT_ID ?? 'default', slug: process.env.DEFAULT_TENANT_SLUG ?? 'default' };
  const tenantId = tenant.id;

  // ── Parse body ─────────────────────────────────────────────────────────────
  const {
    sessionId: clientSessionId,
    message,
    name,
    email,
    address,
    phone,
  } = req.body ?? {};

  if (!message || !message.trim()) {
    return json(res, { error: 'message is required' }, 400);
  }

  // Use phone from body or a synthetic session ID
  const chatPhone = phone ?? `web_${clientSessionId ?? crypto.randomUUID()}`;

  appLogger.info('Web chat inbound', { session: clientSessionId, phone: chatPhone, msgLen: message.length });

  // ── TCPA — web chat still needs consent check ─────────────────────────────
  // For web: check if they have an account/consent record
  // If email or phone provided, look up or create a customer record
  let customerId = null;
  try {
    const { getAdapter } = await import('../fsm/router.js');
    const adapter = getAdapter();
    const customer = await adapter.upsertCustomer({
      phone:   chatPhone,
      email:   email ?? null,
      name:    name ?? null,
      address: address ?? null,
    });
    customerId = customer?.fsm_id ?? null;
  } catch {
    // FSM not configured — continue without customerId
  }

  // Stop-word check (web chats can also have STOP in them)
  const tcpaHandler = new TcpaStopWordHandler({ consentStore, logger: appLogger.info.bind(appLogger) });
  const tcpaResult = tcpaHandler.handleStopWord(message, customerId ?? chatPhone, 'chat');
  if (tcpaResult.stopped) {
    return json(res, {
      text:        'You have been unsubscribed from chat notifications. Contact us directly for further assistance.',
      classification: { intent: 'stop_received', urgency: 'low' },
      suggestions:  [],
      sessionId:   clientSessionId,
    });
  }

  // ── Safety gate ───────────────────────────────────────────────────────────
  const safetyResult = await scan(message, {
    channel:   'chat',
    tenantId,
    messageId: clientSessionId ?? crypto.randomUUID(),
    logFn:    (e) => appLogger.audit('safety_gate', e),
    notifyDispatcherFn: makeDispatcherNotifier({ logFn: (e) => appLogger.audit('dispatcher', e), dispatcherPhone: tenant.dispatcher }),
  });

  // Enqueue
  const entry = enqueue({
    channel:         'chat',
    direction:      'inbound',
    tenant_id:        tenantId,
    raw_input:        message,
    transcript:      null,
    caller_phone:     chatPhone,
    caller_email:     email ?? null,
    service_address: address ?? null,
    contact_name:    name ?? null,
  });

  updateEntry(entry.id, {
    safety_gate_passed:  safetyResult.pass,
    safety_gate_result:  safetyResult.triggers.length > 0
      ? { triggered: true, triggers: safetyResult.triggers, severity: safetyResult.severity, response: safetyResult.response }
      : { triggered: false },
  });

  if (!safetyResult.pass) {
    updateEntry(entry.id, { status: QUEUE_STATUS.ESCALATED });
    return json(res, {
      text:           safetyResult.response,
      classification: { intent: 'escalated', urgency: safetyResult.severity },
      suggestions:    [],
      sessionId:      clientSessionId,
    });
  }

  // ── Pricebook lookup ──────────────────────────────────────────────────────
  let pricebookMatch = null;
  try {
    const { intent } = ruleBasedClassify(message);
    if (['quote_request', 'schedule_service', 'membership'].includes(intent)) {
      const hint = message.toLowerCase().replace(/\b(how much|cost|price|quote|estimate|for|the|my|i need|a)\b/g, '').trim();
      if (hint) {
        pricebookMatch = await lookupPricebook(hint, null);
      }
    }
  } catch {
    // Non-fatal — continue without pricebook
  }

  // ── Layer 2 conversational core ───────────────────────────────────────────
  let outbound;
  try {
    outbound = await processMessage(message, chatPhone, tenantId, pricebookMatch, entry.id);
    updateEntry(entry.id, { llm_classification: outbound.classification });
  } catch (err) {
    appLogger.error('Layer 2 failed for web chat', { error: err.message });
    outbound = {
      text:           'Thanks for your message. A technician will follow up shortly.',
      classification: { intent: 'other', urgency: 'routine' },
      urgency:        'routine',
      needsCallback: false,
      callbackReason: null,
    };
  }

  return json(res, {
    text:           outbound.text,
    classification: outbound.classification,
    urgency:        outbound.urgency,
    needsCallback:  outbound.needsCallback,
    suggestions:    quickRepliesForIntent(outbound.classification?.intent ?? 'other'),
    sessionId:      clientSessionId,
    entryId:        entry.id,
  });
}

/**
 * GET /web/chat — widget configuration endpoint
 *
 * Returns widget config (branding, company name, color, etc.)
 * Consumed by the embeddable widget on page load.
 */
function handleWidgetConfig(req, res) {
  // Multi-tenant widget config
  const tenant = req.tenant ?? {};
  const config = {
    company:       tenant.name ?? process.env.WIDGET_COMPANY_NAME ?? 'HVAC Pro Services',
    tagline:       tenant.tagline ?? process.env.WIDGET_TAGLINE ?? 'Fast, free quotes — no commitment',
    accentColor:   tenant.widgetColor ?? process.env.WIDGET_ACCENT_COLOR ?? '#1a73e8',
    welcomeMessage: tenant.welcomeMsg ?? process.env.WIDGET_WELCOME_MSG ?? "Hi! What can we help you with today?",
    phone:         tenant.channels?.twilio?.fromNumber ?? process.env.TWILIO_FROM_NUMBER ?? null,
    mode:          process.env.WIDGET_MODE ?? 'live',
    features: {
      smsFollowUp:  true,
      quoteRequest: true,
      scheduling:   true,
      callback:     true,
    },
  };

  json(res, config);
}

/**
 * GET /web/chat/history/:sessionId — retrieve conversation history
 *
 * For web widget reload / session resume.
 */
async function handleHistory(req, res) {
  const { sessionId } = req.params;

  if (!sessionId) return json(res, { error: 'sessionId required' }, 400);

  // Synthesize phone from sessionId
  const chatPhone = `web_${sessionId}`;
  try {
    const { getSession } = await import('../conversation/session.js');
    const session = getSession(chatPhone, process.env.DEFAULT_TENANT_ID ?? 'default');
    return json(res, { messages: session?.messages ?? [] });
  } catch {
    return json(res, { messages: [] });
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

export async function registerWebRoutes(app) {
  const { Router } = await import('express');
  const r = Router();

  r.get( '/web/chat',                      handleWidgetConfig);
  r.post('/web/chat',                      handleChat);
  r.get( '/web/chat/history/:sessionId',   handleHistory);

  app.use(r);
}
