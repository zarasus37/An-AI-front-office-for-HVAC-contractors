/**
 * Layer 6 — Compliance Substrate
 *
 * Consent Store: grant/revoke/query for all customer consent records.
 * TCPA Stop-Word Handler: intercepts STOP/UNSUBSCRIBE on all channels.
 * CIPA Disclosure Layer: pre-call disclosure for voice channels.
 *
 * Legal basis:
 *  - TCPA: 47 U.S.C. § 227 — autodialed/prerecorded voice + SMS
 *  - CIPA: Cal. Penal Code § 630 et seq. (California Invasion of Privacy Act) — best practice for all
 *  - All-Party Consent: default standard (can't guarantee single-party states)
 *
 * References:
 *  - TCPA: https://www.law.cornell.edu/uscode/text/47/227
 *  - FCC 2023 order: https://www.fcc.gov/document/fcc-adopts-one-to-one-consent-rule-0
 *  - CIPA: https://www.law.cornell.edu/uscode/text/47/631
 */

// ── Consent Store ─────────────────────────────────────────────────────────────

export const CONSENT_TYPES = {
  CALL_RECORDING:       'call_recording',
  AI_ANALYSIS:          'ai_analysis',
  MARKETING:            'marketing',
  THERMOSTAT_TELEMETRY: 'thermostat_telemetry',
  SMS_INBOUND:          'sms_inbound',
};

export const CONSENT_SOURCES = {
  WEB_FORM:    'web_form',
  VERBAL:      'verbal',
  WRITTEN:     'written',
  SMS_REPLY:   'sms_reply',
  CLICKWRAP:   'clickwrap',
  TERMS_PAGE:  'terms_page',
};

/**
 * In-memory consent store. In production, persists to tenant DB.
 * Schema matches SPEC.md Consent Record:
 * {
 *   id: uuid,
 *   customer_id: uuid,
 *   channel: voice|sms|chat|thermostat,
 *   consent_type: string,
 *   granted: boolean,
 *   granted_at: ISO8601,
 *   revoked_at: ISO8601|null,
 *   scope: string,
 *   ip_address: string|null,
 *   source: web_form|verbal|written|sms_reply|clickwrap|terms_page
 * }
 */
export class ConsentStore {
  constructor() {
    /** @type {Map<string, object[]>} customerId → consent records */
    this._records = new Map();
  }

  /**
   * Grant consent for a customer.
   * @param {object} params
   * @returns {object} created consent record
   */
  grant({ customerId, channel, consentType, scope, ipAddress, source }) {
    const id = crypto.randomUUID();
    const record = {
      id,
      customer_id:   customerId,
      channel:       channel ?? 'sms',
      consent_type: consentType ?? 'sms_inbound',
      granted:       true,
      granted_at:    new Date().toISOString(),
      revoked_at:   null,
      scope:        scope ?? consentType ?? '',
      ip_address:   ipAddress ?? null,
      source:       source ?? CONSENT_SOURCES.WEB_FORM,
    };
    this._put(customerId, record);
    return record;
  }

  /**
   * Revoke consent. Sets revoked_at — records are never deleted (audit trail).
   * @param {object} params
   * @returns {object|null} updated record, or null if not found
   */
  revoke({ customerId, channel, consentType }) {
    const records = this._records.get(customerId) ?? [];
    const idx = records.findIndex(r =>
      r.granted &&
      r.channel === (channel ?? r.channel) &&
      r.consent_type === (consentType ?? r.consent_type) &&
      !r.revoked_at
    );
    if (idx === -1) return null;
    records[idx] = { ...records[idx], revoked_at: new Date().toISOString() };
    this._records.set(customerId, records);
    return records[idx];
  }

  /**
   * Revoke ALL consents for a customer (full opt-out).
   * Used when a TCPA stop-word is received.
   * @param {string} customerId
   * @returns {object[]} all updated records
   */
  revokeAll(customerId) {
    const records = this._records.get(customerId) ?? [];
    const now = new Date().toISOString();
    const updated = records.map(r =>
      r.granted && !r.revoked_at
        ? { ...r, revoked_at: now }
        : r
    );
    this._records.set(customerId, updated);
    return updated;
  }

  /**
   * Query whether a customer has valid (granted, not revoked) consent.
   * @param {string} customerId
   * @param {object} opts
   * @param {string} [opts.channel]
   * @param {string} [opts.consentType]
   * @returns {boolean}
   */
  hasConsent(customerId, opts = {}) {
    const records = this._records.get(customerId) ?? [];
    return records.some(r =>
      r.granted &&
      !r.revoked_at &&
      (!opts.channel      || r.channel === opts.channel) &&
      (!opts.consentType  || r.consent_type === opts.consentType)
    );
  }

  /**
   * Get all consent records for a customer (including revoked).
   * @param {string} customerId
   * @returns {object[]}
   */
  getRecords(customerId) {
    return [...(this._records.get(customerId) ?? [])];
  }

  /**
   * Get the most recent active consent for a specific type.
   * @param {string} customerId
   * @param {string} consentType
   * @returns {object|null}
   */
  getActiveConsent(customerId, consentType) {
    const records = this._records.get(customerId) ?? [];
    const active = records
      .filter(r => r.granted && !r.revoked_at && r.consent_type === consentType)
      .sort((a, b) => new Date(b.granted_at) - new Date(a.granted_at));
    return active[0] ?? null;
  }

  /**
   * Bulk import existing consent records (e.g., from a CSV or DB migration).
   * @param {object[]} records
   */
  bulkImport(records) {
    for (const r of records) {
      this._put(r.customer_id ?? r.customerId, r);
    }
  }

  _put(customerId, record) {
    if (!this._records.has(customerId)) this._records.set(customerId, []);
    this._records.get(customerId).push(record);
  }

  /**
   * Reset store (for testing only)
   */
  _reset() {
    this._records.clear();
  }
}

// ── TCPA Stop-Word Handler ────────────────────────────────────────────────────

/**
 * TCPA stop-word handler.
 * Handles: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT-OUT, OPTOUT
 * Per TCPA: must be honored within 10 business days.
 * Per FCC 2023 one-to-one consent rule: each brand/number needs separate consent.
 *
 * @param {object} opts
 * @param {ConsentStore} opts.consentStore
 * @param {Function}     opts.logger
 */
export class TcpaStopWordHandler {
  constructor(opts) {
    this._store = opts.consentStore;
    this._log   = opts.logger ?? (() => {});
  }

  /**
   * Check if a message contains a TCPA stop word.
   * Case-insensitive. Matches exact word boundaries.
   *
   * @param {string} text
   * @returns {boolean}
   */
  static containsStopWord(text) {
    if (!text) return false;
    const normalized = String(text).toUpperCase().trim();
    return TCPA_STOP_WORDS.some(w => {
      const pattern = new RegExp(`\\b${w.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return pattern.test(normalized);
    });
  }

  /**
   * Process an inbound message for stop-word violations.
   * Returns { stopped: true } if consent was revoked.
   *
   * @param {string} message
   * @param {string} customerId
   * @param {string} channel  - 'sms'|'voice'|'chat'
   * @returns {{ stopped: boolean, record: object|null }}
   */
  handleStopWord(message, customerId, channel = 'sms') {
    if (!TcpaStopWordHandler.containsStopWord(message)) {
      return { stopped: false, record: null };
    }

    (this._log ?? (() => {}))(`[TCPA] Stop-word received from customer ${customerId} on ${channel} — revoking all consent`);

    // Revoke all active consents
    const revokedRecords = this._store.revokeAll(customerId);

    return {
      stopped: true,
      record: revokedRecords,
      revokedCount: revokedRecords.length,
    };
  }

  /**
   * Check if a customer can receive outbound SMS/MMS.
   * Returns true only if they have active, non-revoked SMS consent.
   * @param {string} customerId
   * @returns {boolean}
   */
  canSendSms(customerId) {
    return this._store.hasConsent(customerId, {
      channel:      'sms',
      consentType:  CONSENT_TYPES.SMS_INBOUND,
    });
  }

  /**
   * Get TCPA compliance status for a customer.
   * @param {string} customerId
   * @returns {object}
   */
  getComplianceStatus(customerId) {
    const records = this._store.getRecords(customerId);
    const active  = records.filter(r => r.granted && !r.revoked_at);
    const revoked = records.filter(r => r.revoked_at);
    return {
      customerId,
      canSendSms:         this.canSendSms(customerId),
      activeConsentCount: active.length,
      revokedConsentCount: revoked.length,
      fullyRevoked:       active.length === 0 && revoked.length > 0,
    };
  }
}

const TCPA_STOP_WORDS = [
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'OPT-OUT', 'OPTOUT', 'REMOVE', 'BLOCK', 'NO',
];

// ── CIPA Disclosure Layer ────────────────────────────────────────────────────

/**
 * CIPA Disclosure Layer
 *
 * CIPA § 631(a): explicit disclosure BEFORE transcription/AI analysis.
 * Disclosure must occur BEFORE any AI processing of the call.
 *
 * For voice calls: hard-coded first utterance.
 * For intake form / chat: checkbox + disclosure text.
 *
 * All-party consent standard: default everywhere.
 */

export const CIPA_DISCLOSURE_TEXT = (
  'This call is being handled by an automated assistant and may be ' +
  'recorded for quality assurance purposes. Your call may be analyzed ' +
  'using artificial intelligence to help us serve you better. ' +
  'By continuing, you consent to such recording and AI analysis. ' +
  'If you do not consent, please hang up now or request to speak with a live representative.'
);

export const CIPA_DISCLOSURE_SHORT = (
  'This call may be recorded and analyzed by AI. Continue to speak with us, ' +
  'or request a live representative at any time.'
);

/**
 * Build TwiML for CIPA disclosure as a Say element.
 * Plays the disclosure as the first action on an inbound voice call.
 *
 * @param {object} opts
 * @param {string}  [opts.full=true]  - use full disclosure vs short version
 * @param {string}  [opts.voice='Polly.Joanna']  - AWS Polly voice
 * @param {number}  [opts.loop=1]      - times to repeat
 * @returns {string} TwiML <Say> XML string
 */
export function buildCipaTwiml(opts = {}) {
  const { full = true, voice = 'Polly.Joanna', loop = 1 } = opts;
  const text = full ? CIPA_DISCLOSURE_TEXT : CIPA_DISCLOSURE_SHORT;
  return `<Say voice="${voice}" loop="${loop}">${text}</Say>`;
}

/**
 * Check if a CIPA disclosure has been presented to a caller.
 * In voice: implies the <Say> TwiML was rendered.
 * In chat/form: implies the disclosure checkbox was shown.
 *
 * @param {string} customerId
 * @param {ConsentStore} store
 * @returns {boolean}
 */
export function hasCipaDisclosureBeenPresented(customerId, store) {
  return store.hasConsent(customerId, { consentType: CONSENT_TYPES.AI_ANALYSIS });
}

/**
 * Record that CIPA disclosure was presented and consent was given.
 * @param {string} customerId
 * @param {ConsentStore} store
 * @param {object} meta  - { ipAddress, source }
 */
export function recordCipaConsent(customerId, store, meta = {}) {
  store.grant({
    customerId,
    channel:      'voice',
    consentType:  CONSENT_TYPES.AI_ANALYSIS,
    scope:        CIPA_DISCLOSURE_TEXT,
    source:       meta.source ?? CONSENT_SOURCES.VERBAL,
    ipAddress:    meta.ipAddress ?? null,
  });
}

/**
 * CIPA-compliant TwiML response for an inbound voice call.
 * Plays disclosure first, then proceeds to the rest of the call flow.
 *
 * @param {object} opts
 * @param {string} [opts.nextUrl]  - URL to redirect to after disclosure (the main webhook)
 * @returns {string} TwiML XML
 */
export function buildCipaCompliantVoiceTwiml(opts = {}) {
  const { nextUrl } = opts;
  const cipaTwiml = buildCipaTwiml({ full: true, loop: 1 });

  if (nextUrl) {
    // Redirect to actual call handling after disclosure
    return `<Response>${cipaTwiml}<Redirect method="POST">${nextUrl}</Redirect></Response>`;
  }
  return `<Response>${cipaTwiml}</Response>`;
}

/** Singleton consent store instance */
export const consentStore = new ConsentStore();
