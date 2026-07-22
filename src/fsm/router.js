/**
 * FSM Router
 *
 * Routes FSM calls to the correct adapter based on the tenant's configured FSM.
 * Tenants select their FSM in env vars (e.g., JOBBER_SUBDOMAIN, HCP_API_KEY, etc.).
 *
 * FSM selection priority:
 *   1. Explicit per-tenant config (tenant_id → adapter mapping, future)
 *   2. Global default adapter (process.env.DEFAULT_FSM = 'jobber'|'hcp'|'servicetitan')
 *   3. First available adapter that is configured
 */

import { FsmAdapter, FsmError } from './adapter.js';
import { JobberAdapter }       from './jobber.js';
import { MockFsmAdapter }      from './mock.js';

/** @type {Map<string, FsmAdapter>} */
const _adapters = new Map();

/**
 * Initialize all configured FSM adapters.
 * Call once at server startup.
 */
export async function initializeAdapters() {
  const adapters = [
    ['jobber', new JobberAdapter()],
  ];

  const results = [];

  for (const [name, adapter] of adapters) {
    try {
      await adapter.initialize();
      _adapters.set(name, adapter);
      results.push({ name, status: 'ok' });
      console.log(`[FSM] ${name} adapter initialized`);
    } catch (err) {
      if (err instanceof FsmError && err.type === 'auth') {
        console.warn(`[FSM] ${name} adapter not configured — ${err.message}`);
        results.push({ name, status: 'not_configured', reason: err.message });
      } else {
        console.error(`[FSM] ${name} adapter init failed:`, err.message);
        results.push({ name, status: 'error', reason: err.message });
      }
    }
  }

  return results;
}

/**
 * Get the active FSM adapter.
 * Uses DEFAULT_FSM env var, falls back to first configured adapter.
 *
 * @param {string} [fsmName]  Override — use specific adapter
 * @returns {FsmAdapter}
 * @throws {FsmError} if no adapter available
 */
export function getAdapter(fsmName = null) {
  if (fsmName) {
    const adapter = _adapters.get(fsmName.toLowerCase());
    if (!adapter) throw new FsmError(`FSM '${fsmName}' not found or not configured`, 'unknown', fsmName);
    return adapter;
  }

  const defaultFsm = process.env.DEFAULT_FSM?.toLowerCase();
  if (defaultFsm) {
    const adapter = _adapters.get(defaultFsm);
    if (adapter) return adapter;
  }

  // Fall back to MockFsmAdapter if no real adapters configured
  const mockAdapter = new MockFsmAdapter();
  return mockAdapter;
}

/**
 * Push a qualified queue entry to the FSM.
 * Wraps: upsertCustomer → createJob.
 *
 * @param {object} queueEntry  Queue entry from the queue store
 * @returns {Promise<{ customer: object, job: object }>}
 */
export async function pushLeadToFsm(queueEntry) {
  const adapter = getAdapter();

  const customer = await adapter.upsertCustomer({
    phone:   queueEntry.caller_phone,
    email:    null, // TODO: collect email in intake
    name:     queueEntry.contact_name ?? null,
    address:  queueEntry.service_address ?? null,
  });

  const job = await adapter.createJob({
    customerId:  customer.fsm_id,
    phone:       queueEntry.caller_phone,
    address:     queueEntry.service_address ?? '',
    description: queueEntry.raw_input,
    intent:      queueEntry.llm_classification?.intent ?? 'other',
    urgency:     queueEntry.safety_gate_result?.severity
                 ?? queueEntry.llm_classification?.urgency
                 ?? 'routine',
  });

  return { customer, job };
}

/**
 * Look up a pricebook entry from the FSM.
 *
 * @param {string} serviceName
 * @param {string|null} jobType
 * @returns {Promise<object|null>}
 */
export async function lookupPricebook(serviceName, jobType = null) {
  const adapter = getAdapter();
  return adapter.getPricebookEntry(serviceName, jobType);
}

/**
 * Check if a customer has an active service agreement.
 *
 * @param {string} fsmCustomerId
 * @returns {Promise<object|null>}
 */
export async function checkMembership(fsmCustomerId) {
  const adapter = getAdapter();
  return adapter.getMembership(fsmCustomerId);
}
