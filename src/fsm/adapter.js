/**
 * FSM Adapter Interface
 *
 * Defines the contract for all Field Service Management integrations.
 * Each FSM (Jobber, Housecall Pro, ServiceTitan) implements this interface.
 *
 * Key design decisions:
 * - Auth tokens stored per-tenant in env vars (not in code).
 * - Each method is standalone so individual calls can be retried.
 * - All methods return typed results; errors are caught and re-thrown as FsmError.
 */

/**
 * @typedef {Object} Customer
 * @property {string} fsm_id        External FSM customer ID
 * @property {string|null} name
 * @property {string|null} phone
 * @property {string|null} email
 * @property {string|null} address
 */

/**
 * @typedef {Object} PricebookEntry
 * @property {string} service_name
 * @property {number} price
 * @property {string|null} job_type   'repair'|'maintenance'|'installation'|null
 */

/**
 * @typedef {Object} Job
 * @property {string} fsm_id        External FSM job ID
 * @property {string} status        'queued'|'in_progress'|'completed'|'cancelled'
 */

/**
 * Standard error class for FSM operations.
 */
export class FsmError extends Error {
  /** @type {'auth'|'network'|'validation'|'not_found'|'unknown'} */
  type;
  /** Original error from the FSM, if any */
  cause;
  /** The FSM that generated this error */
  fsm;

  constructor(message, type = 'unknown', fsm = 'unknown', cause = null) {
    super(message);
    this.name = 'FsmError';
    this.type = type;
    this.fsm = fsm;
    this.cause = cause;
  }
}

/**
 * FSM Adapter interface.
 * Each FSM implementation (jobber.js, hcp.js, servicetitan.js) implements these methods.
 */
export class FsmAdapter {
  /**
   * Human-readable name of this FSM.
   * @returns {string}
   */
  get name() { return 'unknown'; }

  /**
   * Initialize the adapter. Called once at startup.
   * Throws FsmError on config missing.
   * @param {object} config  Adapter-specific config (API key, subdomain, etc.)
   */
  async initialize(config) {
    throw new Error('Not implemented');
  }

  /**
   * Look up a customer by phone number or email.
   * Returns null if not found (don't throw for not_found).
   *
   * @param {string} phone
   * @param {string|null} email
   * @returns {Promise<Customer|null>}
   */
  async findCustomer(phone, email) {
    throw new Error('Not implemented');
  }

  /**
   * Create or update a customer record.
   * If the customer already exists in the FSM, update it.
   *
   * @param {{ phone: string, email?: string, name?: string, address?: string }} customer
   * @returns {Promise<Customer>}
   */
  async upsertCustomer(customer) {
    throw new Error('Not implemented');
  }

  /**
   * Create a job (lead) in the FSM intake queue.
   * Tier 1 operation — just pushes to queue for human review.
   *
   * @param {{ customerId: string, phone: string, address: string, description: string, intent: string, urgency: string }} job
   * @returns {Promise<Job>}
   */
  async createJob(job) {
    throw new Error('Not implemented');
  }

  /**
   * Look up a pricebook entry by service name or job type.
   * Returns null if no match found.
   *
   * @param {string} serviceName
   * @param {string|null} jobType
   * @returns {Promise<PricebookEntry|null>}
   */
  async getPricebookEntry(serviceName, jobType) {
    throw new Error('Not implemented');
  }

  /**
   * Check if a customer has an active service agreement / membership.
   * Returns null if no active agreement.
   *
   * @param {string} customerId  FSM customer ID
   * @returns {Promise<{ plan: string, expiresAt: string }|null>}
   */
  async getMembership(customerId) {
    throw new Error('Not implemented');
  }
}
