/**
 * Layer 2 — Price Gate
 *
 * Enforces: model never generates a price unless retrieved from pricebook.
 * Intercepts LLM-generated text and redacts any dollar amounts or price-like
 * content unless a confirmed pricebook entry is attached to the session.
 *
 * Also enforces the fixed fallback string when no pricebook match exists
 * and the customer asks for a price.
 */

import { PRICE_FALLBACK } from './system-prompt.js';

/**
 * @typedef {Object} PriceMatch
 * @property {string}  service_name
 * @property {number}  price
 * @property {string|null} job_type  'repair'|'maintenance'|'installation'|null
 */

/** Regex to find dollar amounts in text */
const DOLLAR_PATTERN = /\$\d+(?:,\d{3})*(?:\.\d{2})?|\d+\s*(?:dollars| bucks)/gi;

/**
 * Check if text contains a price that was NOT from the confirmed pricebook.
 * Returns true if a price was mentioned without authorization.
 *
 * @param {string} text
 * @param {PriceMatch|null} confirmedPricebookMatch
 * @returns {boolean}  true = unauthorized price detected
 */
export function containsUnauthorizedPrice(text, confirmedPricebookMatch) {
  const prices = text.match(DOLLAR_PATTERN);
  if (!prices || prices.length === 0) return false;

  // If we have a confirmed pricebook match, check if the mentioned price matches it
  if (confirmedPricebookMatch) {
    const confirmed = String(confirmedPricebookMatch.price);
    // Check if any match equals the confirmed price
    return !prices.some(p => p.replace(/[$,\s]/g, '') === confirmed);
  }

  // No confirmed pricebook → any price mention is unauthorized
  return true;
}

/**
 * Redact unauthorized prices from text.
 * Replaces detected dollar amounts with [REDACTED].
 *
 * @param {string} text
 * @returns {string}
 */
export function redactPrices(text) {
  return text.replace(DOLLAR_PATTERN, '[REDACTED]');
}

/**
 * Build the price-gated response.
 * If customer asked for a price and no pricebook match exists → return fallback.
 * If text contains unauthorized prices → redact and append disclaimer.
 *
 * @param {string} text           LLM-generated response text
 * @param {string} customerMessage Original customer message
 * @param {PriceMatch|null} confirmedPricebookMatch
 * @returns {string}
 */
export function gateResponse(text, customerMessage, confirmedPricebookMatch = null) {
  const askedForPrice = /\b(price|cost|how much|quote|estimate|charge|fee)\b/i.test(customerMessage);

  // Customer asked for a price and we have no pricebook match
  if (askedForPrice && !confirmedPricebookMatch) {
    return PRICE_FALLBACK;
  }

  // Check for unauthorized price mentions in the response text
  if (containsUnauthorizedPrice(text, confirmedPricebookMatch)) {
    const redacted = redactPrices(text);
    return `${redacted}\n\nNote: Please confirm exact pricing with your technician after on-site diagnosis.`;
  }

  return text;
}

/**
 * Strip markdown formatting from LLM responses.
 * Removes ```json blocks, backtick code fences, etc.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return text
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .replace(/`/g, '')
    .trim();
}
