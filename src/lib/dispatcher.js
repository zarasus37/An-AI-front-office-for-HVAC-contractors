/**
 * Dispatcher Notifier — escalation escalation
 *
 * Called by the safety gate when an emergency or urgent trigger fires.
 * Makes a real voice call to DISPATCHER_PHONE and reads the alert aloud.
 *
 * TCPA note: outbound voice calls TO the contractor (the dispatcher) do not
 * require TCPA consent — the TCPA governs calls TO consumers, not TO the business.
 * This module is intentionally separate from the TCPA consent-gated outbound path.
 */

const DISPATCHER_SCRIPT = (
  'This is an automated safety alert from the HVAC AI front office. ' +
  'A potential emergency has been reported. ' +
  'Please dispatch a technician immediately. ' +
  'Details: ${message}. ' +
  'Time received: ${time}. ' +
  'To acknowledge this alert, please call your dispatch coordinator. ' +
  'Thank you.'
);

/**
 * Call the dispatcher and read the alert aloud via TwiML voice.
 *
 * @param {object} auditEntry — the safety-gate audit entry
 * @param {object} [opts]
 * @param {Function} [opts.logFn] — optional logger
 * @returns {Promise<string>} Twilio call SID
 */
export async function notifyDispatcher(auditEntry, { logFn = () => {} } = {}) {
  const dispatcherPhone = process.env.DISPATCHER_PHONE;
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken  = process.env.TWILIO_AUTH_TOKEN;
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!dispatcherPhone) {
    logFn(`[Dispatcher] DISPATCHER_PHONE not set — skipping escalation call`);
    return null;
  }
  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    logFn(`[Dispatcher] Twilio credentials not configured — skipping escalation call`);
    return null;
  }

  const triggers = auditEntry.triggers ?? [];
  const triggerSummary = triggers.map(t => `${t.label} (${t.severity})`).join(', ') || 'safety trigger';
  const message = auditEntry.full_text_preview ?? auditEntry.full_text ?? '(no transcript)';
  const time    = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const script = DISPATCHER_SCRIPT
    .replace('${message}', message.slice(0, 200))
    .replace('${time}', time);

  // Build TwiML that speaks the alert and stays on the line
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say voice="alice" language="en-US">${escapeXml(script)}</Say>`,
    '  <Pause length="5"/>',
    '  <Say voice="alice" language="en-US">If this is a genuine emergency, please dispatch a technician now.</Say>',
    '</Response>',
  ].join('');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`;
  const form = new URLSearchParams({
    To:       dispatcherPhone,
    From:     twilioFromNumber,
    Url:      `data:text/xml;charset=utf-8,${encodeURIComponent(twiml)}`,
    Method:   'POST',
  });

  const credentials = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      logFn(`[Dispatcher] Twilio call failed ${res.status}: ${err}`);
      return null;
    }

    const data = await res.json();
    logFn(`[Dispatcher] Escalation call placed to ${dispatcherPhone}, SID: ${data.sid}`);
    return data.sid;
  } catch (err) {
    logFn(`[Dispatcher] Failed to place escalation call: ${err.message}`);
    return null;
  }
}

/**
 * Returns a configured dispatcher notifyFn for use in runSafetyGate / scan.
 * Falls back to console.log when DISPATCHER_PHONE is not configured.
 */
export function makeDispatcherNotifier({ logFn = () => {} } = {}) {
  return async (auditEntry) => {
    // Always log first
    logFn(`[Dispatcher ESCALATION] triggers=${JSON.stringify(auditEntry.triggers)}, phone=${auditEntry.phone ?? 'unknown'}`);

    // Try to place the real call
    const sid = await notifyDispatcher(auditEntry, { logFn });

    // If Twilio call failed and we have DISPATCHER_PHONE, log it loudly
    if (sid === null && process.env.DISPATCHER_PHONE) {
      logFn(`[Dispatcher] ⚠️  Twilio call FAILED — check TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER`);
    }

    // Log regardless — visibility into what the dispatcher did
    if (sid !== null) {
      logFn(`[Dispatcher] ✅ Call placed to ${process.env.DISPATCHER_PHONE}, SID: ${sid}`);
    }
  };
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
