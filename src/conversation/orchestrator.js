/**
 * Layer 2 — Conversational Orchestrator
 *
 * Wires together: session store + classifier + price gate + response builder.
 *
 * Flow:
 *   inbound message
 *     → load/create session (per-phone)
 *     → run classifier (LLM or rule-based)
 *     → price gate check
 *     → build outbound response
 *     → push assistant message to session
 *     → update queue entry with classification
 *     → return outbound payload
 */

import { getSession, pushMessage, setClassification, setPricebookMatch } from './session.js';
import { classify } from './classifier.js';
import { gateResponse } from './price-gate.js';
import { buildResponse, buildEscalationResponse, buildCallbackResponse } from './response-builder.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {Object} OrchestratorResult
 * @property {string}   text              Outbound SMS text
 * @property {string}   classification
 * @property {string}   urgency
 * @property {boolean}  needsCallback
 * @property {string|null} callbackReason
 * @property {object|null} pricebookMatch
 * @property {object}   session           Updated session snapshot
 */

/**
 * Process an inbound message through Layer 2.
 *
 * Called from the SMS webhook AFTER the safety gate has cleared.
 *
 * @param {string} message        Current inbound message
 * @param {string} phone         Caller phone (E.164)
 * @param {string} tenantId
 * @param {object|null} pricebookMatch  Confirmed FSM pricebook match (or null)
 * @param {string|null} queueEntryId   Queue entry ID to update
 * @returns {Promise<OrchestratorResult>}
 */
export async function processMessage(message, phone, tenantId, pricebookMatch = null, queueEntryId = null) {
  // ── 1. Load session ───────────────────────────────────────────────────────
  const session = getSession(phone, tenantId);

  // Attach pricebook match to session if provided
  if (pricebookMatch) {
    setPricebookMatch(phone, pricebookMatch);
  }

  // ── 2. Push user message into session ────────────────────────────────────
  pushMessage(phone, 'user', message);

  // ── 3. Get conversation history for classifier ────────────────────────────
  // Import dynamically to avoid circular deps — actually no circular, session is fine
  const { getHistoryForPrompt } = await import('./session.js');
  const history = getHistoryForPrompt(phone);

  // ── 4. Classify ───────────────────────────────────────────────────────────
  logger.debug('Classifying message', { phone, message: message.substring(0, 50) });
  const { classification } = await classify(message, history, null, pricebookMatch ?? null);

  // ── 5. Store classification in session ────────────────────────────────────
  setClassification(phone, classification);

  // ── 6. Price gate check ───────────────────────────────────────────────────
  // Note: actual LLM text response goes through gateResponse in step 8.
  // Step 6 only flags if we need to block a price before sending.
  let outboundText;

  if (classification.needs_callback) {
    outboundText = buildCallbackResponse(classification.callback_reason);
  } else {
    // Placeholder — in prod, this is the raw LLM response.
    // Here we use the classification to construct a reasonable direct response.
    outboundText = routeToDirectResponse(message, classification);
  }

  // ── 7. Apply price gate ────────────────────────────────────────────────────
  const gatedText = gateResponse(outboundText, message, pricebookMatch ?? null);

  // ── 8. Build final response ───────────────────────────────────────────────
  const outbound = buildResponse(gatedText, classification, pricebookMatch ?? null);

  // ── 9. Push assistant message to session ──────────────────────────────────
  pushMessage(phone, 'assistant', outbound.text);

  // ── 10. Log audit ──────────────────────────────────────────────────────────
  logger.audit('layer2_outbound', {
    phone,
    tenantId,
    queueEntryId,
    classification,
    outbound: { text: outbound.text, urgency: outbound.urgency },
  });

  return {
    ...outbound,  // text, classification (object), urgency, needsCallback, callbackReason, pricebookMatch
    session: { ...session },
  };
}

/**
 * Direct response router — maps classification intent to a direct text response.
 * Used in dev mode (no LLM) and as fallback if LLM call fails.
 *
 * @param {string} message   Original customer message
 * @param {object} classification
 * @returns {string}
 */
function routeToDirectResponse(message, classification) {
  const lower = message.toLowerCase();

  // Emergency already handled by safety gate — should not reach here
  // but handle just in case
  if (classification.intent === 'emergency') {
    return "Thank you. I'm getting a technician to you right now. Please stay safe.";
  }

  switch (classification.intent) {
    case 'schedule_service': {
      // Collect info for scheduling
      const hasAddress = /\d+\s+\w+\s+(st|ave|rd|dr|blvd|way|ln|ct|court|pl|place)/i.test(lower);
      const hasEquipment = /\b(ac|air\s*condition|hvac|furnace|heat\s*pump|boiler|thermostat)\b/i.test(lower);
      const hasSymptom = /\b(not\s*work|broken|leak|noise|loud|warm|hot|cold|no\s*heat|no\s*cool)\b/i.test(lower);

      if (!hasAddress) {
        return "I'd be happy to help schedule a visit. What's the service address?";
      }
      if (!hasEquipment) {
        return "Got it — what's the equipment you're having trouble with? (e.g., AC, furnace, heat pump)";
      }
      if (!hasSymptom) {
        return "Thanks. Can you describe the problem you're experiencing?";
      }
      return "I've got your request. A technician will reach out shortly to confirm an appointment time.";
    }

    case 'quote_request': {
      // Price gate fires in routeResponse — this is a fallback
      return "I'd be happy to help with a quote. A technician will provide an exact price on-site after diagnosing the issue.";
    }

    case 'membership': {
      return "Great question about our maintenance plans! A member services representative will follow up with details shortly.";
    }

    case 'inquiry': {
      // Try to answer simple questions directly using HVAC glossary context
      if (lower.includes('what is seer') || lower.includes('seer rating')) {
        return "SEER = Seasonal Energy Efficiency Ratio. Higher SEER means more efficient cooling. Current minimum is SEER 14 for new systems.";
      }
      if (lower.includes('what is afue') || lower.includes('afue rating')) {
        return "AFUE = Annual Fuel Utilization Efficiency. It's the ratio of heat output to fuel input for furnaces/boilers. 90%+ AFUE is considered high efficiency.";
      }
      return "Thanks for reaching out. A technician will follow up with more information.";
    }

    case 'other':
    default: {
      return "Thanks for your message. We'll be in touch shortly.";
    }
  }
}
