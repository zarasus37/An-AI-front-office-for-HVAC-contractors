/**
 * Layer 2 — Response Builder
 *
 * Takes a raw LLM response (or a direct response object) and converts it
 * into a structured outbound SMS payload.
 *
 * Handles:
 * - SMS truncation (160 chars per segment, concatenation supported by carriers)
 * - Markdown stripping
 * - Follow-up question extraction (for multi-turn conversations)
 * - Classification echo (optional)
 */

import { stripMarkdown } from './price-gate.js';

const MAX_SMS_LENGTH = 160;

/**
 * @typedef {Object} OutboundMessage
 * @property {string} text         SMS body
 * @property {string} classification  intent classification
 * @property {string} urgency      emergency|urgent|routine|low
 * @property {boolean} needsCallback
 * @property {string|null} callbackReason
 * @property {object|null} pricebookMatch
 */

/**
 * Truncate text to max SMS length, breaking on word boundary.
 * @param {string} text
 * @param {number} [max=160]
 * @returns {string}
 */
function truncate(text, max = MAX_SMS_LENGTH) {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  // Break at last space before max
  const truncated = clean.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > max * 0.7
    ? truncated.slice(0, lastSpace) + '...'
    : truncated.slice(0, max - 3) + '...';
}

/**
 * Build the outbound message.
 *
 * @param {string|object} response  Raw LLM text OR direct response object
 * @param {object} classification  Classification result from classifier
 * @param {object|null} pricebookMatch  Confirmed pricebook match or null
 * @returns {OutboundMessage}
 */
export function buildResponse(response, classification, pricebookMatch = null) {
  let text;

  if (typeof response === 'string') {
    text = stripMarkdown(response);
  } else if (response && typeof response === 'object') {
    // Direct structured response (from fallback/dev mode)
    text = response.text ?? 'Thanks — we received your message and will follow up shortly.';
  } else {
    text = 'Thanks — we received your message and will follow up shortly.';
  }

  const truncated = truncate(text);

  return {
    text:           truncated,
    classification:  classification ?? { intent: 'other', urgency: 'routine' },
    urgency:        classification?.urgency ?? 'routine',
    needsCallback:  classification?.needs_callback ?? false,
    callbackReason: classification?.callback_reason ?? null,
    pricebookMatch: pricebookMatch ?? null,
  };
}

/**
 * Build an escalation response (after safety gate triggered).
 * Short, authoritative, no further questions.
 * @returns {{ text: string, classification: 'emergency', urgency: 'emergency', needsCallback: boolean }}
 */
export function buildEscalationResponse() {
  return {
    text:          "I've received what may be a gas or carbon monoxide emergency from this location. I'm connecting you with our emergency line right now. Please leave the building and stay outside until our technician arrives. If you need immediate help, please call 911.",
    classification: 'emergency',
    urgency:       'emergency',
    needsCallback: false,
    callbackReason: null,
    pricebookMatch: null,
  };
}

/**
 * Build a needs-callback response.
 * Sent when the classifier marks needs_callback = true.
 *
 * @param {string} reason  Reason for callback (from classification.callback_reason)
 * @returns {string}
 */
export function buildCallbackResponse(reason) {
  const text = reason
    ? `Thanks — a technician will follow up with you shortly. ${reason}`
    : 'Thanks — a technician will follow up with you shortly.';
  return truncate(text);
}

/**
 * Split a long message into SMS segments.
 * Returns array of strings, each ≤ 160 chars.
 *
 * @param {string} text
 * @param {number} [max=160]
 * @returns {string[]}
 */
export function splitSegments(text, max = MAX_SMS_LENGTH) {
  if (text.length <= max) return [text];
  const segments = [];
  let remaining = text;
  let n = 1;
  while (remaining.length > 0) {
    const prefix = `(${n}) `;
    const chunk = remaining.slice(0, max - prefix.length);
    const lastSpace = chunk.lastIndexOf(' ');
    const safe = lastSpace > max * 0.7 ? chunk.slice(0, lastSpace) : chunk;
    segments.push(prefix + safe);
    remaining = remaining.slice(safe.length);
    n++;
  }
  return segments;
}
