/**
 * Layer 2 — Intent Classifier
 *
 * Calls Anthropic Claude with the system prompt + conversation history
 * and returns a structured classification object.
 *
 * Falls back to a rule-based classifier if the API key is not set (dev mode).
 */

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, PRICE_FALLBACK } from './system-prompt.js';

// ── Raw LLM call ─────────────────────────────────────────────────────────────────

/**
 * @param {string} message     Current user message
 * @param {string} history     Formatted prior messages (from session.getHistoryForPrompt)
 * @param {object} safetyGateResult  Safety gate result object or null
 * @param {object|null} pricebookMatch  Pricebook match from FSM or null
 * @returns {Promise<string>}  Raw Claude text response
 */
async function callClaude(message, history, safetyGateResult, pricebookMatch) {
  const client = new Anthropic();

  // Build safety gate context block
  const safetyBlock = safetyGateResult?.triggered
    ? `SAFETY GATE ALERT: The following emergency patterns were detected — respond with a safety acknowledgment and do NOT attempt to schedule an appointment.\nTriggers: ${JSON.stringify(safetyGateResult.triggers.map(t => t.label))}`
    : 'Safety gate: passed (no emergency detected).';

  const priceBlock = pricebookMatch
    ? `Confirmed pricebook entry: ${pricebookMatch.service_name} — $${pricebookMatch.price}`
    : 'No confirmed pricebook entry for this request.';

  const userContent = history
    ? `Prior conversation:\n${history}\n\nCurrent message: ${message}`
    : `Current message: ${message}`;

  const response = await client.messages.create({
    model:      process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${safetyBlock}\n\n${priceBlock}\n\n${userContent}`,
      },
    ],
  });

  return response.content[0].text;
}

// ── JSON extraction ─────────────────────────────────────────────────────────────

/**
 * Extract the classification JSON from Claude's text response.
 * Claude may wrap it in markdown fences.
 * @param {string} text
 * @returns {object}
 */
function extractClassification(text) {
  // Try JSON in markdown fence
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) { /* fall through */ }
  }
  // Try bare JSON object
  const bare = text.match(/\{[\s\S]*?\}/);
  if (bare) {
    try { return JSON.parse(bare[0]); } catch (_) { /* fall through */ }
  }
  return null;
}

// ── Valid intents ────────────────────────────────────────────────────────────────

const VALID_INTENTS   = ['schedule_service', 'quote_request', 'membership', 'inquiry', 'emergency', 'other'];
const VALID_URGENCIES = ['emergency', 'urgent', 'routine', 'low'];
const VALID_JOB_TYPES  = ['repair', 'maintenance', 'installation', 'inspection', 'other', null];
const VALID_EQUIPMENT = ['heat_pump', 'furnace', 'boiler', 'straight_cool', 'mini_split', 'package_unit', 'other', null];

/**
 * Sanitize and validate a classification object.
 * @param {object|null} obj
 * @returns {object}
 */
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    intent:            VALID_INTENTS.includes(obj.intent) ? obj.intent : 'other',
    urgency:           VALID_URGENCIES.includes(obj.urgency) ? obj.urgency : 'routine',
    job_type:          VALID_JOB_TYPES.includes(obj.job_type) ? obj.job_type : null,
    equipment_type:   VALID_EQUIPMENT.includes(obj.equipment_type) ? obj.equipment_type : null,
    pricebook_match:   obj.pricebook_match && typeof obj.pricebook_match === 'object'
      ? { service_name: String(obj.pricebook_match.service_name ?? ''), price: Number(obj.pricebook_match.price) || null }
      : null,
    needs_callback:    Boolean(obj.needs_callback),
    callback_reason:   obj.callback_reason ? String(obj.callback_reason) : null,
  };
}

// ── Rule-based fallback ──────────────────────────────────────────────────────────

const URGENT_KEYWORDS = [
  'no heat', 'not working', 'broken', 'leak', 'flood',
  'smoke', 'gas', 'fire', 'sparking', 'flooding',
  'burst', 'overflow', 'no ac', 'no cooling', 'no heat',
  'urgent', 'asap', 'emergency',
];

const HIGH_URGENCY_THRESHOLD = ['smoke', 'gas', 'fire', 'sparking', 'leak', 'flood', 'burst', 'no heat'];

const RULE_INTENT_KEYWORDS = {
  // quote_request checked BEFORE schedule_service so "how much" always wins over "repair"
  quote_request:    ['price', 'cost', 'quote', 'estimate', 'how much', 'charge', 'fee', 'rate'],
  schedule_service:  ['schedule', 'appointment', 'book', 'come out', 'visit', 'availability', 'open', 'can you come', 'fix', 'repair', 'replace', 'install'],
  membership:        ['membership', 'plan', 'contract', 'agreement', 'renew', 'join', 'sign up'],
  inquiry:           ['how', 'what', 'when', 'where', 'why', 'question', 'wondering', 'curious'],
  emergency:         ['emergency', 'urgent', 'asap', 'help', 'danger', 'leak', 'fire', 'smoke', 'gas'],
};

function detectUrgency(message) {
  const lower = message.toLowerCase();
  // High urgency keywords → emergency
  if (HIGH_URGENCY_THRESHOLD.some(k => lower.includes(k))) return 'urgent';
  // General urgent keywords
  if (URGENT_KEYWORDS.some(k => lower.includes(k))) return 'urgent';
  return 'routine';
}

/**
 * Very lightweight rule-based classifier for dev mode (no API key).
 * @param {string} message
 * @returns {object}
 */
function ruleBasedClassify(message) {
  const lower = message.toLowerCase();
  for (const [intent, keywords] of Object.entries(RULE_INTENT_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      const urgency = detectUrgency(message);
      return { intent, urgency, job_type: 'repair', equipment_type: null, pricebook_match: null, needs_callback: false, callback_reason: null };
    }
  }
  // No intent keyword matched — still check urgency
  const urgency = detectUrgency(message);
  return { intent: 'other', urgency, job_type: null, equipment_type: null, pricebook_match: null, needs_callback: false, callback_reason: null };
}

// ── Public API ──────────────────────────────────────────────────────────────────

export { ruleBasedClassify };
/**
 * Classify a customer message.
 *
 * @param {string} message
 * @param {string} [history='']        Formatted prior messages
 * @param {object|null} [safetyGateResult=null]
 * @param {object|null} [pricebookMatch=null]
 * @returns {Promise<{ classification: object, rawResponse: string|null }>}
 */
export async function classify(message, history = '', safetyGateResult = null, pricebookMatch = null) {
  // Check env lazily — not at module import time — so tests can override
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  if (!hasApiKey) {
    const fallback = ruleBasedClassify(message);
    return { classification: fallback, rawResponse: null };
  }

  try {
    const rawResponse = await callClaude(message, history, safetyGateResult, pricebookMatch);
    const parsed = extractClassification(rawResponse);
    const sanitized = sanitize(parsed);
    return { classification: sanitized, rawResponse };
  } catch (err) {
    console.error('[Classifier] Claude call failed:', err.message);
    const fallback = ruleBasedClassify(message);
    return { classification: fallback, rawResponse: null };
  }
}
