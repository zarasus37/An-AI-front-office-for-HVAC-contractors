/**
 * IoT Customer Registry
 *
 * Maps thermostat serial numbers → customer records.
 * In production: replace with FSM customer lookup or tenant DB query.
 * For dev/testing: an in-memory Map that can be seeded.
 *
 * Schema per entry:
 * {
 *   thermostat_serial: string,
 *   customer_id:       string,    // tenant-level UUID
 *   phone:             string,    // E.164
 *   name:              string,
 *   service_address:   string,
 *   iot_consent:      boolean,   // THERMOSTAT_TELEMETRY consent granted
 *   baseline?: { avgRuntime: number, avgCycleCount: number }
 * }
 */

import { consentStore, CONSENT_TYPES } from '../compliance/consent-store.js';

/** @type {Map<string, object>} */
const _registry = new Map();

/**
 * Register a thermostat → customer mapping.
 * Called during onboarding or FSM sync.
 *
 * @param {object} record
 */
export function registerThermostat(record) {
  _registry.set(record.thermostat_serial, {
    ...record,
    iot_consent: record.iot_consent ?? false,
  });
}

/**
 * Look up a customer record by thermostat serial.
 *
 * @param {string} serial
 * @returns {object|null}
 */
export function getCustomerByThermostat(serial) {
  return _registry.get(serial) ?? undefined;
}

/**
 * Set thermostat telemetry consent for a customer.
 * Calls consentStore.grant/revoke so revocation cascades properly.
 *
 * @param {string} customerId  — tenant-level customer UUID
 * @param {boolean} granted
 */
export function setThermostatConsent(customerId, granted) {
  if (granted) {
    consentStore.grant({ customerId, consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY, source: 'customer_registry' });
  } else {
    consentStore.revoke({ customerId, consentType: CONSENT_TYPES.THERMOSTAT_TELEMETRY });
  }
}

/**
 * Clear all registrations (testing).
 */
export function _clearRegistry() {
  _registry.clear();
}

/**
 * Seed with sample data for dev/testing.
 */
export function seedDevRegistry() {
  _clearRegistry();
  registerThermostat({
    thermostat_serial: 'SIM001',
    customer_id:       'cust-dev-001',
    phone:             '+15551001001',
    name:              'Alex Rivera',
    service_address:   '123 Oak St, Austin, TX 78701',
    iot_consent:       true,
    baseline:          { avgRuntime: 400, avgCycleCount: 3 },
  });
  registerThermostat({
    thermostat_serial: 'SIM002',
    customer_id:       'cust-dev-002',
    phone:             '+15551001002',
    name:              'Jordan Kim',
    service_address:   '456 Pine Ave, Austin, TX 78702',
    iot_consent:       true,
    baseline:          { avgRuntime: 300, avgCycleCount: 2 },
  });
  registerThermostat({
    thermostat_serial: 'SIM003',
    customer_id:       'cust-dev-003',
    phone:             '+15551001003',
    name:              'Sam Patel',
    service_address:   '789 Elm Blvd, Austin, TX 78703',
    iot_consent:       false, // no consent — should be skipped
    baseline:          { avgRuntime: 500, avgCycleCount: 4 },
  });
}
