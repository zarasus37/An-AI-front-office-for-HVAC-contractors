/**
 * Conversation session store — per-phone message history
 *
 * Keeps the last N messages per caller phone for multi-turn conversations.
 * Session TTL: configurable (default 30 min of inactivity).
 *
 * Persistence strategy (mirrors src/queue/store.js):
 *   - Append-only JSONL log (data/sessions.jsonl) — every session write
 *   - Full snapshot (data/sessions-snapshot.json) — every SNAPSHOT_EVERY writes
 *   - On startup: snapshot exists → load it; otherwise replay JSONL log
 *   - TTL is enforced at load time — a session whose lastActivityAt is older
 *     than the TTL is NOT restored, even if it's sitting in the snapshot/log.
 *
 * Acceptable for pilot week. Replace with Redis/Postgres before contractor #2.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';

/** @type {Map<string, Session>} */
const _sessions = new Map();

// ── Persistence config ──────────────────────────────────────────────────────
const DATA_DIR      = process.env.SESSION_DATA_DIR     || './data';
const LOG_FILE       = `${DATA_DIR}/sessions.jsonl`;
const SNAPSHOT_FILE  = `${DATA_DIR}/sessions-snapshot.json`;
// Sessions write ~2× per exchange (inbound push + outbound push) vs queue
// entries which are ~1× per message — snapshot more frequently so the JSONL
// log doesn't grow unbounded during an active conversation.
const SNAPSHOT_EVERY = parseInt(process.env.SESSION_SNAPSHOT_EVERY || '30', 10);

const DEFAULT_TTL_MS = 30 * 60 * 1000;  // 30 min
const MAX_HISTORY    = 20;               // keep last N messages per session

let _writeCount = 0;

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
 * @property {object|null} classification
 * @property {object|null} pricebookMatch
 */

// ── Init: replay from snapshot or JSONL, dropping anything past TTL ─────────
function _init() {
  mkdirSync(DATA_DIR, { recursive: true });

  const isExpired = (session) => {
    const elapsed = Date.now() - new Date(session.lastActivityAt).getTime();
    return elapsed >= DEFAULT_TTL_MS;
  };

  if (existsSync(SNAPSHOT_FILE)) {
    try {
      const snap = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (Array.isArray(snap)) {
        let restored = 0, dropped = 0;
        for (const session of snap) {
          if (isExpired(session)) { dropped++; continue; }
          _sessions.set(session.phone, session);
          restored++;
        }
        console.log(`[Session] Restored ${restored} sessions from snapshot (${dropped} expired, dropped)`);
        return;
      }
    } catch (e) {
      console.warn('[Session] Snapshot corrupt, replaying JSONL:', e.message);
    }
  }

  if (existsSync(LOG_FILE)) {
    try {
      const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const op = JSON.parse(line);
          if (op._op === 'upsert' && op.session) {
            _sessions.set(op.session.phone, op.session);
          } else if (op._op === 'delete' && op.phone) {
            _sessions.delete(op.phone);
          }
        } catch {}
      }
      // Drop anything expired after full replay (only the final state matters)
      let dropped = 0;
      for (const [phone, session] of _sessions) {
        if (isExpired(session)) { _sessions.delete(phone); dropped++; }
      }
      console.log(`[Session] Replayed ${_sessions.size} sessions from JSONL log (${dropped} expired, dropped)`);
    } catch (e) {
      console.warn('[Session] JSONL replay failed:', e.message);
    }
  }
}

function _appendLog(op) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ ...op, _ts: new Date().toISOString() }) + '\n');
  } catch (e) {
    console.error('[Session] Failed to write to JSONL log:', e.message);
  }
}

async function _snapshot() {
  try {
    const sessions = [..._sessions.values()];
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(sessions));
    writeFileSync(LOG_FILE, '');
    _writeCount = 0;
    console.log(`[Session] Snapshot saved (${sessions.length} sessions), log truncated`);
  } catch (e) {
    console.error('[Session] Snapshot failed:', e.message);
  }
}

function _writeOp(session, op) {
  _appendLog({ _op: op, session });
  _writeCount++;
  if (_writeCount % SNAPSHOT_EVERY === 0) {
    _snapshot(); // fire-and-forget; don't await — matches queue/store.js pattern
  }
}

// ── Init on module load ─────────────────────────────────────────────────────
_init();

// ── Public API ─────────────────────────────────────────────────────────────

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
    // Session expired — record the expiry in the log so log and Map stay consistent
    _sessions.delete(phone);
    _appendLog({ _op: 'delete', phone });
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
  _writeOp(session, 'upsert');
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
  _writeOp(session, 'upsert');
}

/**
 * Attach a classifier result to the session.
 */
export function setClassification(phone, classification) {
  const session = _sessions.get(phone);
  if (!session) return;
  session.classification = classification;
  _writeOp(session, 'upsert');
}

/**
 * Attach a pricebook match to the session.
 */
export function setPricebookMatch(phone, pricebookMatch) {
  const session = _sessions.get(phone);
  if (!session) return;
  session.pricebookMatch = pricebookMatch;
  _writeOp(session, 'upsert');
}

/**
 * Get formatted history for LLM prompt injection.
 * Format:
 *   [user] message
 *   [assistant] message
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
  _appendLog({ _op: 'delete', phone });
}

/**
 * Force a snapshot before shutdown for cleanest recovery.
 */
export async function flush() {
  await _snapshot();
}

/** Testing utility */
export function _clearAll() {
  _sessions.clear();
  _writeCount = 0;
  try {
    writeFileSync(LOG_FILE, '');
    writeFileSync(SNAPSHOT_FILE, '[]');
  } catch {}
}

export const SESSION_TTL_MS = DEFAULT_TTL_MS;
