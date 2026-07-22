/**
 * Conversation session store — per-phone message history
 *
 * Keeps the last N messages per caller phone for multi-turn conversations.
 * Session TTL: configurable (default 30 min of inactivity).
 * Replace with Redis in prod.
 */

import { randomUUID } from 'crypto';

/** @type {Map<string, Session>} */
const _sessions = new Map();

/**
 * @typedef {Object} Message
 * @property {string} role     'user' | 'assistant'
 * @property {string} content
 * @property {string} ts       ISO8601
 */

/**
 * @typedef {Object} Session
 * @property {string}   phone
 * @property {string}   tenantId
 * @property {Message[]} history
 * @property {string}   lastActivityAt  ISO8601
 * @property {object|null} classification  from Layer 2 classifier
 * @property {object|null} pricebookMatch  from FSM pricebook lookup
 */

const DEFAULT_TTL_MS   = 30 * 60 * 1000;  // 30 min
const MAX_HISTORY      = 20;                // keep last N messages per session

/**
 * Get or create a session for a phone number.
 * @param {string} phone  E.164 caller phone
 * @param {string} tenantId
 * @param {number} [ttlMs]
 */
export function getSession(phone, tenantId, ttlMs = DEFAULT_TTL_MS) {
  const existing = _sessions.get(phone);

  if (existing) {
    const elapsed = Date.now() - new Date(existing.lastActivityAt).getTime();
    if (elapsed < ttlMs) {
      return existing;
    }
    // session expired — clear it
    _sessions.delete(phone);
  }

  /** @type {Session} */
  const session = {
    phone,
    tenantId,
    history: [],
    lastActivityAt: new Date().toISOString(),
    classification: null,
    pricebookMatch: null,
  };
  _sessions.set(phone, session);
  return session;
}

/**
 * Push a message into a session's history.
 * Keeps MAX_HISTORY most recent messages.
 * @param {string} phone
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
export function pushMessage(phone, role, content) {
  const session = _sessions.get(phone);
  if (!session) return;

  session.history.push({ role, content, ts: new Date().toISOString() });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  session.lastActivityAt = new Date().toISOString();
}

/**
 * Attach a classifier result to the session.
 */
export function setClassification(phone, classification) {
  const session = _sessions.get(phone);
  if (!session) return;
  session.classification = classification;
}

/**
 * Attach a pricebook match to the session.
 */
export function setPricebookMatch(phone, pricebookMatch) {
  const session = _sessions.get(phone);
  if (!session) return;
  session.pricebookMatch = pricebookMatch;
}

/**
 * Get formatted history for LLM prompt injection.
 * Format: "Customer (3 messages):
 *  - [user] 2024-01-01 10:01: hello
 *  - [asst] 2024-01-01 10:01: Hi, how can I help?
 *  - [user] 2024-01-01 10:02: my ac is making noise"
 *
 * @param {string} phone
 * @returns {string}
 */
export function getHistoryForPrompt(phone) {
  const session = _sessions.get(phone);
  if (!session || session.history.length === 0) return '';
  return session.history
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n');
}

/**
 * Clear a session (e.g., after ticket is closed).
 */
export function clearSession(phone) {
  _sessions.delete(phone);
}

/**
 * Clear all sessions (testing).
 */
export function _clearAll() {
  _sessions.clear();
}

export const SESSION_TTL_MS = DEFAULT_TTL_MS;
