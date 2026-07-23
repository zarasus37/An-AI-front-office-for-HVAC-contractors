/**
 * InboundQueue — persistent intake queue
 *
 * Schema matches SPEC.md Layer 1 "Unified Queue Entry Schema".
 *
 * Persistence strategy:
 *   - Append-only JSONL log (data/queue.jsonl) — every enqueue/update
 *   - Full snapshot (data/queue-snapshot.json) — every SNAPSHOT_EVERY writes
 *   - On startup: snapshot exists → load it; otherwise replay JSONL log
 *
 * Acceptable for pilot week. Replace with Redis/Postgres before contractor #2.
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** @type {Map<string, QueueEntry>} */
const _store = new Map();

// ── Persistence config ──────────────────────────────────────────────────────
const DATA_DIR        = process.env.QUEUE_DATA_DIR      || './data';
const LOG_FILE        = `${DATA_DIR}/queue.jsonl`;
const SNAPSHOT_FILE   = `${DATA_DIR}/queue-snapshot.json`;
const SNAPSHOT_EVERY  = parseInt(process.env.QUEUE_SNAPSHOT_EVERY || '50', 10);

let _writeCount = 0;

// ── Init: replay from snapshot or JSONL ─────────────────────────────────────
function _init() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      const snap = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (Array.isArray(snap)) {
        for (const entry of snap) _store.set(entry.id, entry);
        console.log(`[Queue] Restored ${_store.size} entries from snapshot`);
        return;
      }
    } catch (e) {
      console.warn('[Queue] Snapshot corrupt, replaying JSONL:', e.message);
    }
  }
  if (existsSync(LOG_FILE)) {
    try {
      const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const op = JSON.parse(line);
          if (op._op === 'upsert' && op.entry) {
            _store.set(op.entry.id, op.entry);
          } else if (op._op === 'delete' && op.id) {
            _store.delete(op.id);
          }
        } catch {}
      }
      console.log(`[Queue] Replayed ${_store.size} entries from JSONL log`);
    } catch (e) {
      console.warn('[Queue] JSONL replay failed:', e.message);
    }
  }
}

function _appendLog(op) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ ...op, _ts: new Date().toISOString() }) + '\n');
  } catch (e) {
    console.error('[Queue] Failed to write to JSONL log:', e.message);
  }
}

async function _snapshot() {
  try {
    const entries = [..._store.values()];
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(entries));
    // Truncate the JSONL log after a successful snapshot
    writeFileSync(LOG_FILE, '');
    console.log(`[Queue] Snapshot saved (${entries.length} entries), log truncated`);
  } catch (e) {
    console.error('[Queue] Snapshot failed:', e.message);
  }
}

function _writeOp(entry, op) {
  _appendLog({ _op: op, entry });
  _writeCount++;
  if (_writeCount % SNAPSHOT_EVERY === 0) {
    _snapshot(); // async fire-and-forget; don't await
  }
}

// ── Init on module load ────────────────────────────────────────────────────
_init();

/**
 * @typedef {Object} QueueEntry
 * @property {string}   id
 * @property {string}   channel          'voice'|'sms'|'chat'|'google_lsa'|'yelp'|'thumbtack'|'angi'
 * @property {string}   direction        'inbound'|'outbound'
 * @property {string}   tenant_id
 * @property {string}   raw_input
 * @property {string|null} transcript
 * @property {string|null} caller_phone    E.164
 * @property {string|null} caller_email
 * @property {string|null} service_address
 * @property {string|null} contact_name
 * @property {string}   received_at       ISO8601
 * @property {boolean}  safety_gate_passed
 * @property {object|null} safety_gate_result
 * @property {object|null} llm_classification
 * @property {string}   status            'queued'|'qualified'|'escalated'|'scheduled'|'closed'|'pending'|'proactive_outreach'
 * @property {string|null} disposition_note
 * @property {string}   priority          'normal'|'high'
 * @property {object}   flags
 */

/**
 * Enqueue a new message.
 * @param {Omit<QueueEntry, 'id'|'received_at'|'safety_gate_passed'|'safety_gate_result'|'llm_classification'>} raw
 */
export function enqueue(raw) {
  /** @type {QueueEntry} */
  const entry = {
    id:                  randomUUID(),
    received_at:         new Date().toISOString(),
    status:              raw.status ?? 'queued',
    safety_gate_passed:   true,
    safety_gate_result:   null,
    llm_classification:  null,
    ...raw,
  };
  _store.set(entry.id, entry);
  _writeOp(entry, 'upsert');
  return entry;
}

/**
 * Fetch a queue entry by id.
 * @param {string} id
 * @returns {QueueEntry|undefined}
 */
export function getEntry(id) {
  return _store.get(id);
}

/**
 * Update mutable fields on an existing entry.
 * @param {string} id
 * @param {Partial<QueueEntry>} patch
 */
export function updateEntry(id, patch) {
  const existing = _store.get(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...patch };
  _store.set(id, updated);
  _writeOp(updated, 'upsert');
  return updated;
}

/**
 * List entries with optional filters.
 * @param {{ tenantId?: string, status?: string, limit?: number }} opts
 */
export function listEntries({ tenantId = null, status = null, limit = 100 } = {}) {
  let entries = [..._store.values()];
  if (tenantId) entries = entries.filter(e => e.tenant_id === tenantId);
  if (status)  entries = entries.filter(e => e.status === status);
  return entries
    .sort((a, b) => b.received_at.localeCompare(a.received_at))
    .slice(0, limit);
}

/**
 * Force a snapshot (call before shutting down for cleanest recovery).
 */
export async function flush() {
  await _snapshot();
}

/**
 * Drain all entries (testing utility).
 */
export function _clearAll() {
  _store.clear();
  try {
    writeFileSync(LOG_FILE, '');
    writeFileSync(SNAPSHOT_FILE, '[]');
  } catch {}
}

export const QUEUE_STATUS = {
  QUEUED:     'queued',
  QUALIFIED:  'qualified',
  ESCALATED:  'escalated',
  SCHEDULED:  'scheduled',
  CLOSED:     'closed',
};
