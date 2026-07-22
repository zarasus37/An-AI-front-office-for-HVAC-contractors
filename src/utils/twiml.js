/**
 * TwiML helpers — build valid Twilio XML responses without the twilio SDK dependency.
 * Used in webhook handlers so we don't need to load the full twilio SDK at request time.
 *
 * TwiML spec: https://www.twilio.com/docs/voice/twiml
 */

/**
 * Build a TwiML Messaging response with a single <Message> element.
 * @param {string} body — SMS text (max 1600 chars for single SMS)
 * @returns {string} Valid TwiML XML
 */
export function twimlResponse(body) {
  const escaped = String(body)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/**
 * Build a TwiML Voice response with a <Say> element.
 * @param {string} text
 * @param {string} [voice='alice']  TwiML voice
 * @param {string} [language='en-US']
 * @returns {string}
 */
export function twimlVoiceSay(text, { voice = 'alice', language = 'en-US' } = {}) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">${escaped}</Say></Response>`;
}

/**
 * Redirect to a different TwiML URL (for call forwarding).
 * @param {string} url
 * @returns {string}
 */
export function twimlRedirect(url) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${url}</Redirect></Response>`;
}
