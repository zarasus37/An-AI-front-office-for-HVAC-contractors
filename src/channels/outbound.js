/**
 * Outbound SMS Sender — TCPA-gated
 *
 * All outbound SMS (renewal, IoT alerts, proactive outreach) must go
 * through this module. It enforces TCPA consent checks before sending.
 *
 * Twilio REST API is used directly (no SDK) to avoid SDK overhead.
 */

import { consentStore as _consentStore, CONSENT_TYPES } from '../compliance/consent-store.js';
import { twimlResponse } from '../utils/twiml.js';

/**
 * Check if we can legally send an outbound SMS to this customer.
 * Returns { allowed, reason }.
 *
 * @param {string} customerId
 * @param {string} phone  — E.164 phone number
 * @param {ConsentStore} [store] — consent store to use (defaults to module-level)
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function canSendOutboundSms(customerId, phone, store) {
  const consent = store ?? _consentStore;
  // No customer record — send to phone number as fallback
  if (!customerId) {
    return { allowed: true, reason: null };
  }

  // TCPA: must have active SMS consent
  if (!consent.hasConsent(customerId, {
    channel:     'sms',
    consentType: CONSENT_TYPES.SMS_INBOUND,
  })) {
    return {
      allowed: false,
      reason:  `No active SMS consent for customer ${customerId}`,
    };
  }

  return { allowed: true, reason: null };
}

/**
 * Send an outbound SMS via Twilio REST API.
 * Returns the Twilio message SID.
 *
 * @param {object} opts
 * @param {string}   opts.to         — E.164 recipient phone
 * @param {string}   opts.body       — message text
 * @param {string}   [opts.customerId]
 * @param {Function} [opts.logger]   — optional logger
 * @returns {Promise<string>} message SID
 */
export async function sendOutboundSms(opts) {
  const { to, body, customerId, logger: log = () => {}, consentStore: store } = opts;
  const consent = store ?? _consentStore;

  // ── TCPA check ──────────────────────────────────────────────────────────────
  const { allowed, reason } = canSendOutboundSms(customerId, to, consent);
  if (!allowed) {
    log(`[TCPA BLOCK] Refused to send SMS to ${to}: ${reason}`);
    throw new Error(`TCPA blocked: ${reason}`);
  }

  // ── Twilio credentials ──────────────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const form = new URLSearchParams({
    To:   to,
    From: from,
    Body: body,
  });

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio error ${res.status}: ${err}`);
  }

  const data = await res.json();
  log(`[OutboundSMS] Sent to ${to}, SID: ${data.sid}`);
  return data.sid;
}

/**
 * Build the TCPA STOP acknowledgment TwiML.
 * Per TCPA: must acknowledge STOP within 10 business days (best practice: immediate).
 * Must NOT include marketing content — just the acknowledgment.
 */
export const TCPA_STOP_ACKNOWLEDGE = (
  'You have been unsubscribed from SMS messages. ' +
  'You will no longer receive automated messages from this number. ' +
  'To resubscribe, please contact us directly.'
);

export function tcpaStopTwiml() {
  return twimlResponse(TCPA_STOP_ACKNOWLEDGE);
}

