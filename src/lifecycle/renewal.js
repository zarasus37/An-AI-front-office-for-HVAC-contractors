/**
 * Layer 5 — Lifecycle Automation
 *
 * Renewal outreach engine: calendar-triggered and telemetry-triggered.
 * Route clustering: group customers by zip code to avoid call floods.
 */

// ── Renewal Trigger Types ─────────────────────────────────────────────────────

export const RENEWAL_TRIGGERS = {
  CALENDAR:         'calendar',         // Annual/multi-year contract expiring
  TELEMETRY_SPIKE:  'telemetry_spike', // Unusual signal volume from IoT layer
  SEASONAL:         'seasonal',         // Seasonal tune-up window (spring/fall)
  MANUAL:           'manual',           // Admin-triggered
};

// ── Renewal Campaign ─────────────────────────────────────────────────────────

export class RenewalOutreachEngine {
  /**
   * @param {object} opts
   * @param {object} opts.queueStore   - queue store instance
   * @param {object} opts.fsmAdapter    - FSM adapter for membership lookup
   * @param {string} opts.tenantId
   * @param {string} opts.tenantSlug
   * @param {Function} opts.logger
   */
  constructor(opts) {
    this._queue  = opts.queueStore;
    this._fsm    = opts.fsmAdapter;
    this._tid    = opts.tenantId;
    this._tslug  = opts.tenantSlug;
    this._log    = opts.logger ?? (() => {});
  }

  /**
   * Determine which customers need renewal outreach.
   *
   * @param {object} opts
   * @param {'calendar'|'telemetry_spike'|'seasonal'|'manual'} opts.trigger
   * @param {Date}   [opts.asOf]         - reference date (default: now)
   * @param {string}  [opts.zipCode]      - filter by zip code
   * @param {string}  [opts.planType]     - filter by plan tier
   * @returns {Promise<object[]>}          - list of customers to contact
   */
  async findRenewalCandidates(opts = {}) {
    const trigger  = opts.trigger ?? RENEWAL_TRIGGERS.CALENDAR;
    const asOf     = opts.asOf ?? new Date();
    const customers = [];

    // In production: query tenant DB for active agreements expiring soon.
    // For now, return an empty array — the actual query would be:
    //
    // SELECT c.*, a.plan_type, a.expires_at, a.renewal_outreach_count
    //   FROM customers c
    //   JOIN agreements a ON a.customer_id = c.id
    //  WHERE a.status = 'active'
    //    AND a.renewal_outreach_count < 3
    //    AND (
    //      (trigger = 'calendar'     AND a.expires_at BETWEEN :now AND :window)
    //      OR (trigger = 'seasonal'   AND MONTH(a.expires_at) = MONTH(:now + 30 days))
    //      OR (trigger = 'telemetry'  AND c.signal_score < :threshold)
    //    )
    //  ORDER BY a.expires_at ASC

    this._log(`[RenewalEngine] findRenewalCandidates trigger=${trigger} asOf=${asOf.toISOString()}`);

    // TODO: replace with real DB query
    return customers;
  }

  /**
   * Build renewal outreach messages for a set of customers.
   * Uses the classifier/orchestrator pipeline for personalized messages,
   * but falls back to fixed templates when LLM is unavailable.
   *
   * @param {object[]} customers
   * @param {object} opts
   * @param {Function} opts.sendSms  - async function(phone, message) → void
   * @returns {Promise<object[]>} results
   */
  async runRenewalCampaign(customers, opts = {}) {
    const { sendSms } = opts;
    const results = [];

    for (const customer of customers) {
      const planType = customer.plan_type ?? 'unknown';

      // Template selection based on plan tier
      const templateArr = RENEWAL_TEMPLATES[planType] ?? RENEWAL_TEMPLATES.default;
      const template = Array.isArray(templateArr)
        ? templateArr[Math.floor(Math.random() * templateArr.length)]
        : templateArr;

      // Personalization tokens
      const message = template
        .replace(/\{\{name\}\}/g,    customer.name ?? 'there')
        .replace(/\{\{plan\}\}/g,    customer.plan_name ?? 'your plan')
        .replace(/\{\{expires\}\}/g, customer.expires_at
          ? new Date(customer.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
          : 'soon')
        .replace(/\{\{price\}\}/g,   customer.annual_price ? `$${customer.annual_price}` : 'current rate');

      // Enqueue as outbound outreach entry
      const entryId = await this._queue.enqueue({
        tenantId:   this._tid,
        tenantSlug: this._tslug,
        channel:    'sms',
        direction:  'outbound',
        rawInput:   message,
        status:     'outbound_renewal',
        priority:   'normal',
        flags: {
          renewal:           true,
          trigger:            'calendar',
          customer_id:        customer.id,
          plan_type:          planType,
          outreach_attempt:    (customer.renewal_outreach_count ?? 0) + 1,
        },
        classification: {
          intent:      'renewal_outreach',
          urgency:     'routine',
          plan_type:   planType,
          proactive:   true,
        },
      });

      // Send immediately if sendSms is provided
      if (sendSms) {
        try {
          await sendSms(customer.phone, message);
          await this._queue.updateEntry(entryId, { status: 'outbound_sent' });
          this._log(`[RenewalEngine] Sent to ${customer.phone}: ${message.slice(0, 50)}...`);
        } catch (err) {
          await this._queue.updateEntry(entryId, { status: 'outbound_failed' });
          this._log(`[RenewalEngine] Failed to send to ${customer.phone}: ${err.message}`);
        }
      }

      results.push({ customerId: customer.id, phone: customer.phone, entryId });
    }

    return results;
  }

  /**
   * Called by the IoT layer when a customer's signal volume spikes.
   * Triggers a high-priority renewal outreach alongside a service flag.
   *
   * @param {string} customerId
   * @param {object} signalData
   * @returns {Promise<string>} queue entry id
   */
  async triggerTelemetryRenewal(customerId, signalData) {
    this._log(`[RenewalEngine] telemetry_spike for customer ${customerId}`);

    // Enqueue high-priority proactive outreach
    const entryId = await this._queue.enqueue({
      tenantId:   this._tid,
      tenantSlug: this._tslug,
      channel:    'sms',
      direction:  'outbound',
      rawInput:   'Our records show your system may need attention. Would you like to schedule a maintenance check?',
      status:     'proactive_outreach',
      priority:   'high',
      flags: {
        renewal:        true,
        trigger:        'telemetry_spike',
        customer_id:    customerId,
        signal_types:   signalData.signalTypes ?? [],
        proactive:      true,
      },
      classification: {
        intent:     'renewal_outreach',
        urgency:    'routine',
        proactive:  true,
      },
    });

    return entryId;
  }
}

// ── Renewal Templates ────────────────────────────────────────────────────────

const RENEWAL_TEMPLATES = {
  premium: [
    'Hi {{name}}! Your {{plan}} is up for renewal on {{expires}}. Lock in your rate and keep your priority service status — reply YES to renew or call us to schedule your next inspection.',
    'Hi {{name}}! Quick reminder: your {{plan}} renews {{expires}}. As a premium member you have first-priority scheduling — we make it easy. Reply or call!',
  ],
  standard: [
    'Hi {{name}}! Time to think about keeping your {{plan}} active — it expires {{expires}}. Regular maintenance keeps small issues from becoming big bills. Reply to renew!',
  ],
  basic: [
    'Hi {{name}}! Your {{plan}} is expiring {{expires}}. Protect your home with annual coverage starting at {{price}}. Reply to learn about upgrading your plan!',
  ],
  default: [
    'Hi {{name}}! Your service plan with us is up for renewal {{expires}}. We\'d love to keep you covered — reply to chat about your options!',
  ],
};

// ── Route Clustering ───────────────────────────────────────────────────────────

export class RouteCluster {
  /**
   * Group customers by zip code to optimize field technician routes.
   * Ensures no single day has more than maxPerZip renewals to avoid
   * "renewal call floods" in a single neighborhood.
   *
   * @param {object[]} customers  - [{id, service_address, phone, ...}]
   * @param {object} opts
   * @param {number} [opts.maxPerZipPerDay=15]  - max outreach per zip per day
   * @returns {Map<string, object[]>}  zip → customers assigned to that zip
   */
  static clusterByZip(customers, opts = {}) {
    const maxPerZip = opts.maxPerZipPerDay ?? 15;

    // Group by zip
    const byZip = new Map();
    for (const c of customers) {
      const zip = extractZip(c.service_address ?? c.address ?? '');
      if (!zip) continue;
      if (!byZip.has(zip)) byZip.set(zip, []);
      byZip.get(zip).push(c);
    }

    // Distribute within each zip across available days (spread evenly)
    const schedule = new Map(); // zip → [{ day: N, customers: [] }]
    for (const [zip, zipCustomers] of byZip) {
      const buckets = Math.ceil(zipCustomers.length / maxPerZip);
      const bucketsArr = Array.from({ length: buckets }, () => []);

      zipCustomers.forEach((c, i) => {
        const bucket = i % buckets;
        bucketsArr[bucket].push(c);
      });

      schedule.set(zip, bucketsArr.map((customers, day) => ({ day: day + 1, customers })));
    }

    return schedule;
  }

  /**
   * Flatten the schedule into a list of { customer, scheduledDay } objects.
   * @param {Map} schedule  - output of clusterByZip
   * @returns {object[]}
   */
  static flatten(schedule) {
    const result = [];
    for (const [zip, days] of schedule) {
      for (const { day, customers } of days) {
        for (const customer of customers) {
          result.push({ ...customer, scheduledDay: day, zip });
        }
      }
    }
    return result;
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Extract 5-digit US ZIP code from an address string.
 * @param {string} address
 * @returns {string|null}
 */
export function extractZip(address) {
  if (!address) return null;
  const match = String(address).match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : null;
}

/**
 * Build a day-by-day outreach schedule from a list of customers.
 * Uses route clustering to spread outreach across days and avoid zip floods.
 *
 * @param {object[]} customers
 * @param {object} opts
 * @param {number} [opts.maxPerDay=50]     - max total outreach calls per day
 * @param {number} [opts.maxPerZip=15]     - max per zip per day
 * @param {number} [opts.startDay=1]        - first day offset (1 = tomorrow)
 * @returns {object[]} scheduled outreach tasks
 */
export function buildRenewalSchedule(customers, opts = {}) {
  const maxPerDay = opts.maxPerDay ?? 50;
  const schedule  = RouteCluster.clusterByZip(customers, opts);

  const flattened = RouteCluster.flatten(schedule);

  // Assign day numbers based on capacity
  const dayMap = new Map(); // day number → customers
  let currentDay = opts.startDay ?? 1;

  for (const item of flattened) {
    if (!dayMap.has(currentDay)) dayMap.set(currentDay, []);
    if (dayMap.get(currentDay).length >= maxPerDay) {
      currentDay++;
      dayMap.set(currentDay, []);
    }
    dayMap.get(currentDay).push({ ...item, scheduledDay: currentDay });
  }

  return Array.from(dayMap.entries()).flatMap(([day, customers]) => customers);
}
