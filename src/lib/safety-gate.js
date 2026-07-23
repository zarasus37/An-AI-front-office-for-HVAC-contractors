/**
 * Layer 0 — Deterministic Safety Gate
 *
 * Runs every inbound transcript through a regex/keyword layer BEFORE LLM classification.
 * This is a hard gate — a hit cannot be soft-reasoned around by the LLM.
 *
 * The architecture principle: never let the LLM be the only thing between
 * a gas-leak report and a routine appointment.
 *
 * Audit log schema matches SPEC.md Layer 0.
 */

import { makeDispatcherNotifier } from './dispatcher.js';

export const EMERGENCY_PATTERNS = [
  // Gas / CO / Fire — highest priority, most dangerous false negative
  // ── Gas / CO / Fire ──────────────────────────────────────────────────────────
  // gas_smell: bidirectional — positive lookahead on BOTH sides prevents double-consumption
  // (?=gas.*smell) gas.*smell → gas comes first, smell comes after
  // (?=smell.*gas) smell.*gas → smell comes first, gas comes after
  // \b before smell/smells anchors the left; lookahead checks the right term exists
  { id: 'gas_smell',        regex: /(?=\bgas\b.*\bsmells?\b)\bgas\b.*\bsmells?\b|(?=\bsmells?\b.*\bgas\b)\bsmells?\b.*\bgas\b/i, label: 'gas_smell', severity: 'emergency' },
  { id: 'carbon_monoxide',  regex: /carbon\s*monoxide/i,                                                          label: 'carbon_monoxide',  severity: 'emergency' },
  { id: 'co_detector',     regex: /co[\s_-]?detector|co[\s_-]?alarm|co2[\s_-]?(detector|alarm)/i,         label: 'co_detector',      severity: 'emergency' },
  { id: 'smoke',           regex: /\bsmoke\b(?![\s\w]*\b(detector|alarm\b))(?!\s*going\s*off)/i,          label: 'smoke',            severity: 'emergency' },
  { id: 'smoke_detector',  regex: /smoke\s*detector\s*(going\s*off|is|has|went|blaring|beeping|alarming)/i, label: 'smoke',         severity: 'emergency' },
  { id: 'smoke_alarm',     regex: /smoke\s+alarm\s+(going\s*off|is|has|went|blaring|beeping|alarming)/i, label: 'smoke',            severity: 'emergency' },
  { id: 'fire',            regex: /\bfire\b|\bflames?\b|\bburning\b(?!\s*electrical)/i,                    label: 'fire',             severity: 'emergency' },
  { id: 'burning_smell',   regex: /burning\s*(smell|electrical)/i,                                          label: 'burning_smell',    severity: 'urgent' },
  { id: 'gas_leak',        regex: /gas\s*leak|gas\s*line\s*(break|rupture)/i,                              label: 'gas_leak',         severity: 'emergency' },
  { id: 'refrigerant_leak',regex: /\bleak(?:ing)?\b|\s+leak\b|refrigerant|freon/i,                                 label: 'refrigerant_leak', severity: 'urgent' },

  // ── Electrical ────────────────────────────────────────────────────────────────
  { id: 'sparking',        regex: /sparking|spark\s*(ing)?\s*(wires?|electrical|outlet)/i,                    label: 'sparking',         severity: 'emergency' },
  { id: 'short_circuit',   regex: /short\s*(circuit|wire|out)/i,                                               label: 'short_circuit',   severity: 'urgent' },
  { id: 'electrical_burn', regex: /electrical\s*burn/i,                                                          label: 'electrical',       severity: 'emergency' },
  { id: 'breaker_tripped', regex: /breaker\s*(tripped|won't\s*reset|keep(s)?\s*tripping)/i,                    label: 'electrical',       severity: 'urgent' },

  // ── Vulnerable Occupants ─────────────────────────────────────────────────────
  // Match heating/cooling failure + vulnerable descriptor (age, person type, or condition)
  // "heat not working" + newborn also needs to catch — add "is(n'?t) working" variant
  { id: 'no_heat_elderly', regex: /(?:no\s*|(?:heat|heating|furnace|boiler)\s*(?:is|are)?\s*(?:not|isn'?t|aren'?t)\s*(?:working|on|functioning)\s*and\s*)?(?:(?!no\s*)(?:heat|heating|furnace|boiler)).*?((?:elderly|senior|elder|parent|grandmother|grandfather|child|baby|toddler|infant|newborn|disabled)|(?:\d{1,3}\s*(?:yr|year|years?|month|months?)\s*old)|(?:kids?|children?|family)\s*(?:with|at\s*home)|(?:with\s*(?:kids?|children?|infants?|babies?)))|(?:(?:elderly|senior|elderly|grandmother|grandfather|child|baby|toddler|infant|newborn).*?(?:no\s*)?(?:heat|heating|furnace|boiler))|(?:no\s*(?:ac|air\s*condition(?:ing)?|cooling|cool|heat|heating|furnace|boiler).*?(?:kid|child|baby|toddler|elder|senior|infant|newborn|disabled|\d{1,3}\s*(?:yr|year|years?)\s*old))|(?:(?:kid|child|baby|toddler|infant|newborn|disabled|\d{1,3}\s*(?:yr|year|years?)\s*old).*?no\s*(?:ac|air\s*condition(?:ing)?|cooling|cool|heat|heating|furnace|boiler))/i, label: 'vulnerable_occupant', severity: 'emergency' },
  { id: 'no_ac_child',     regex: /no\s*(ac|air\s*condition(ing)?|cooling|cool).*?((kid|child|baby|toddler|elder|senior|infant|newborn)|(\d{2}\s*(yr|year|years?|month|months?)\s*old)|(kids?|children?)\s*with)|(kid|child|baby|toddler|infant|newborn).*no\s*(ac|air\s*condition(ing)?|cooling|cool)/i, label: 'vulnerable_occupant', severity: 'emergency' },
  { id: 'heat_not_working_winter', regex: /(heat|heating|furnace|boiler)\s*(not|isn'?t|won't)\s*work.*(winter|cold|snow|freezing|below\s*(zero|32|20)|kids?|children?|family|home)|(winter|cold|snow|freezing).*?(heat|heating|furnace|boiler)\s*(not|isn'?t|won't)\s*work/i, label: 'heat_emergency', severity: 'emergency' },
  { id: 'ac_extreme_heat', regex: /((ac|air\s*condition(ing)?|cooling|cool)\s*(not|isn'?t|won't|is\s*not)\s*(work(ing)?|on|running)|(95|96|97|98|99|100|105|110)\s*degrees?\s*(outside|inside|in\s*here|outside|in\s*the|in\s*our|here)|(outside|in\s*here|here|in\s*the\s*house)\s*(95|96|97|98|99|100|105|110)\s*degrees?)/i, label: 'heat_emergency', severity: 'emergency' },

  // ── Gas Poisoning Symptoms ───────────────────────────────────────────────────
  { id: 'gas_poisoning',   regex: /gas\s*poisoning|dizziness\s*(from|after)\s*(the\s*)?(heat|furnace|heater|running)|sick\s*after\s*(the\s*)?(heat|furnace|heater)|headache\s*(and)?\s*nausea.*(heat|furnace|gas|heater)|nausea\s*(and)?\s*headache.*(heat|furnace|gas|heater)/i, label: 'gas_poisoning', severity: 'emergency' },
  { id: 'unconscious',     regex: /unconscious|passed\s*out|found\s*unresponsive/i,                            label: 'unconscious',      severity: 'emergency' },

  // ── Explosion / Rupture ──────────────────────────────────────────────────────
  { id: 'explosion',       regex: /explosion|exploded|rupture/i,                                                  label: 'explosion',        severity: 'emergency' },
  { id: 'gas_odor',        regex: /gas\s*odou?r/i,                                                                label: 'gas_smell',        severity: 'emergency' },
];

export const ESCALATION_RESPONSE = (
  "I've received what may be a gas or carbon monoxide emergency from this location. " +
  "I'm connecting you with our emergency line right now. Please leave the building " +
  "and stay outside until our technician arrives. If you need immediate help, please call 911."
);

export const DISPATCHER_ESCALATION_RESPONSE = (
  "This is an automated safety escalation from the AI front office. " +
  "A potential gas leak, carbon monoxide, or other HVAC emergency has been reported. " +
  "Please dispatch a technician immediately."
);

/**
 * scan — primary exported function
 *
 * @param {string} text — raw transcript or inbound message
 * @param {object} opts
 * @param {string} opts.channel — 'voice'|'sms'|'chat'
 * @param {string} opts.tenantId — tenant identifier
 * @param {string} opts.messageId — unique inbound message ID
 * @param {Function} opts.logFn — async function(auditEntry) for persistence
 * @param {Function} opts.notifyDispatcherFn — async function(auditEntry) for escalation webhook
 * @returns {object} { pass: boolean, triggers: array, auditEntry: object }
 */
export async function scan(text, opts = {}) {
  const {
    channel    = 'chat',
    tenantId   = 'default',
    messageId  = null,
    logFn      = null,
    notifyDispatcherFn = null,
  } = opts;

  const hits = [];
  for (const pattern of EMERGENCY_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match) {
      hits.push({
        id:       pattern.id,
        label:    pattern.label,
        severity: pattern.severity,
        matched:  match[0],
        index:    match.index,
      });
    }
  }

  const escalated = hits.length > 0;
  const topSeverity = escalated
    ? hits.reduce((worst, h) => {
        const order = { emergency: 0, urgent: 1, routine: 2 };
        return (order[h.severity] ?? 2) < (order[worst] ?? 2) ? h.severity : worst;
      }, hits[0].severity)
    : null;

  const auditEntry = {
    event:                       'safety_gate_result',
    timestamp:                   new Date().toISOString(),
    channel,
    tenant_id:                   tenantId,
    message_id:                  messageId,
    safety_gate_passed:          !escalated,
    safety_gate_triggered:       escalated,
    triggers:                    hits,
    top_severity:                topSeverity,
    escalation_action:           escalated ? 'dispatcher_notified' : null,
    disposition:                  'pending_review',
    full_text:                   text,
    full_text_preview:           text.substring(0, 200),
  };

  if (logFn) {
    try { await logFn(auditEntry); } catch (e) { /* non-blocking */ }
  }

  if (escalated && notifyDispatcherFn) {
    try { await notifyDispatcherFn(auditEntry); } catch (e) { /* non-blocking */ }
  }

  return {
    pass:    !escalated,
    triggers: hits,
    severity: topSeverity,
    response: escalated ? ESCALATION_RESPONSE : null,
    auditEntry,
  };
}

/**
 * runSafetyGate — convenience wrapper for use inside a route handler
 * Returns the scan result and sets HTTP response fields.
 */
export async function runSafetyGate(req) {
  const body = req.body || {};
  const text = body.transcript || body.message || body.raw_input || '';
  const channel = body.channel || inferChannel(req);
  const tenantId = body.tenant_id || 'default';

  const logFn = async (entry) => {
    // TODO: wire to actual audit log storage (Logmatic, S3, etc.)
    console.log('[SafetyGate Audit]', JSON.stringify(entry));
  };

  const result = await scan(text, {
    channel,
    tenantId,
    messageId: body.id || null,
    logFn,
    notifyDispatcherFn: makeDispatcherNotifier({ logFn }),
  });

  return result;
}

function inferChannel(req) {
  if (req.headers?.['x-twilio-signature']) return 'voice';
  if (req.path?.includes('sms')) return 'sms';
  return 'chat';
}
