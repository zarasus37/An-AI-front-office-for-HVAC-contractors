/**
 * FSM Mock Adapter — for testing and development without live FSM credentials.
 *
 * In-memory implementation of FsmAdapter that simulates:
 * - Customer lookup by phone
 * - Customer upsert
 * - Job creation
 * - Pricebook lookup
 * - Membership check
 *
 * Does NOT require network access or real API keys.
 */

import { randomUUID } from 'crypto';
import { FsmAdapter } from './adapter.js';

/** @type {Map<string, MockCustomer>} */
const _customers = new Map();

/** @type {Map<string, MockJob>} */
const _jobs = new Map();

/** @type {MockPricebookEntry[]} */
const _pricebook = [
  { service_name: 'AC Repair',            price: 89,   job_type: 'repair' },
  { service_name: 'Furnace Repair',        price: 95,   job_type: 'repair' },
  { service_name: 'Heat Pump Repair',     price: 110,  job_type: 'repair' },
  { service_name: 'Boiler Repair',        price: 120,  job_type: 'repair' },
  { service_name: 'Thermostat Install',    price: 75,   job_type: 'installation' },
  { service_name: 'Mini-Split Install',    price: 250,  job_type: 'installation' },
  { service_name: 'AC Tune-Up',           price: 69,   job_type: 'maintenance' },
  { service_name: 'Furnace Tune-Up',      price: 79,   job_type: 'maintenance' },
  { service_name: 'Heat Pump Tune-Up',    price: 85,   job_type: 'maintenance' },
  { service_name: 'Annual Maintenance',   price: 149,  job_type: 'maintenance' },
  { service_name: 'Refrigerant Recharge', price: 180,  job_type: 'repair' },
  { service_name: 'Ductwork Repair',      price: 95,   job_type: 'repair' },
  { service_name: 'Electrical Repair',    price: 100,  job_type: 'repair' },
  { service_name: 'Compressor Replacement', price: 450, job_type: 'repair' },
  { service_name: 'Emergency Service',     price: 150,  job_type: 'repair' },
];

/** @type {Map<string, { plan: string, expiresAt: string }>}  fsm_id → agreement */
const _agreements = new Map();

export class MockFsmAdapter extends FsmAdapter {
  get name() { return 'mock'; }

  async initialize(config = {}) {
    // Reset state between test runs if configured
    if (config.resetState) {
      _customers.clear();
      _jobs.clear();
      _agreements.clear();
      // Reset pricebook to default entries
      _pricebook.length = 0;
      _pricebook.push(
        { service_name: 'AC Repair',            price: 89,   job_type: 'repair' },
        { service_name: 'Furnace Repair',        price: 95,   job_type: 'repair' },
        { service_name: 'Heat Pump Repair',     price: 110,  job_type: 'repair' },
        { service_name: 'Boiler Repair',        price: 120,  job_type: 'repair' },
        { service_name: 'Thermostat Install',    price: 75,   job_type: 'installation' },
        { service_name: 'Mini-Split Install',    price: 250,  job_type: 'installation' },
        { service_name: 'AC Tune-Up',           price: 69,   job_type: 'maintenance' },
        { service_name: 'Furnace Tune-Up',      price: 79,   job_type: 'maintenance' },
        { service_name: 'Heat Pump Tune-Up',    price: 85,   job_type: 'maintenance' },
        { service_name: 'Annual Maintenance',   price: 149,  job_type: 'maintenance' },
        { service_name: 'Refrigerant Recharge', price: 180,  job_type: 'repair' },
        { service_name: 'Ductwork Repair',      price: 95,   job_type: 'repair' },
        { service_name: 'Electrical Repair',    price: 100,  job_type: 'repair' },
        { service_name: 'Compressor Replacement', price: 450, job_type: 'repair' },
        { service_name: 'Emergency Service',     price: 150,  job_type: 'repair' },
      );
    }
  }

  async findCustomer(phone, email) {
    for (const c of _customers.values()) {
      if (phone && c.phone === phone) return c;
      if (email && c.email === email) return c;
    }
    return null;
  }

  async upsertCustomer({ phone, email, name, address }) {
    // Check if customer already exists
    const existing = await this.findCustomer(phone, email);
    if (existing) {
      // Update fields
      if (name)    existing.name    = name;
      if (address) existing.address = address;
      return existing;
    }

    // Create new
    const customer = {
      fsm_id:  `mock_cust_${randomUUID().slice(0, 8)}`,
      phone:   phone ?? null,
      email:   email ?? null,
      name:    name  ?? null,
      address: address ?? null,
    };
    _customers.set(customer.fsm_id, customer);
    return customer;
  }

  async createJob({ customerId, phone, address, description, intent, urgency }) {
    const job = {
      fsm_id:  `mock_job_${randomUUID().slice(0, 8)}`,
      status:  'queued',
      customerId,
      description,
      intent,
      urgency,
    };
    _jobs.set(job.fsm_id, job);
    return job;
  }

  async getPricebookEntry(serviceName, jobType) {
    if (!serviceName && !jobType) return null;

    if (serviceName) {
      const stopWords = new Set(['a','an','the','is','are','was','were','be','to','of','and','or','in','on','at','for','with','my','i','it','you','we','they','this','that','have','has','had','not','no','do','does','did']);
      const keywords = serviceName.toLowerCase().split(/\s+/).filter(k => k.length > 1 && !stopWords.has(k));
      const scored = _pricebook.map(entry => {
        const nameLower = entry.service_name.toLowerCase();
        const score = keywords.filter(k => nameLower.includes(k)).length;
        return { entry, score };
      }).filter(s => s.score >= 2)  // require ≥2 keyword matches to avoid false positives
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) return scored[0].entry;
    }

    if (jobType) {
      const match = _pricebook.find(e => e.job_type === jobType);
      if (match) return match;
    }

    return null;
  }

  async getMembership(customerId) {
    return _agreements.get(customerId) ?? null;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────────

  /** Seed a mock customer with an active membership */
  seedCustomerWithMembership(customer, plan = 'Premium Maintenance Plan') {
    _customers.set(customer.fsm_id, customer);
    _agreements.set(customer.fsm_id, {
      plan,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  /** Seed an entry directly into the mock pricebook */
  seedPricebookEntry(entry) {
    _pricebook.push(entry);
  }
}
