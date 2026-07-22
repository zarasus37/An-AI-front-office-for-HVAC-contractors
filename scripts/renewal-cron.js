/**
 * L5 Renewal Outreach — Daily Cron Script
 *
 * Run daily to find customers with expiring agreements and send
 * renewal SMS via Twilio. Reads config from environment variables.
 *
 * Env vars required:
 *   TWILIO_ACCOUNT_SID  — your Twilio Account SID
 *   TWILIO_AUTH_TOKEN   — your Twilio Auth Token
 *   TWILIO_FROM_NUMBER  — E.164 SMS sender number (e.g. +1...)
 *   DEFAULT_TENANT_ID   — tenant slug (default: "default")
 *   RENEWAL_DAYS_NOTICE — days before expiry to start outreach (default: 30)
 *   MAX_DAILY_OUTREACH  — max SMS to send per day (default: 50)
 *   BASE_URL            — public URL of your HVAC AI server
 *
 * Optional (FSM):
 *   JOBBER_ACCESS_TOKEN  — Jobber API token
 *   JOBBER_SUBDOMAIN    — Jobber subdomain
 *   DEFAULT_FSM         — "jobber" | "mock"
 *
 * Usage (standalone):
 *   node scripts/renewal-cron.js
 *
 * Usage (cron job via Hermes scheduler):
 *   See cronjob(action='create', prompt=...) with skills=['hvac-ai-build']
 */

import { initializeAdapters, getAdapter } from '../src/fsm/router.js';
import { enqueue, updateEntry, listEntries } from '../src/queue/store.js';
import { RenewalOutreachEngine, RENEWAL_TRIGGERS } from '../src/lifecycle/renewal.js';

// ── Mock Data ──────────────────────────────────────────────────────────────────

/**
 * In production: replace with a real DB call (Postgres/Supabase/etc.)
 * that queries active agreements expiring within RENEWAL_DAYS_NOTICE.
 *
 * Schema: { id, name, phone, service_address, plan_type, plan_name, expires_at, renewal_outreach_count }
 */
function getMockRenewalCandidates() {
  const now = new Date();

  const plans = [
    { id: 'cust_001', name: 'Alice Martinez',    phone: '+15552001001', service_address: '101 Oak Ln, Weslaco TX 78596',    plan_type: 'premium',  plan_name: 'Elite Protection',  expires_at: addDays(now, 12), renewal_outreach_count: 0 },
    { id: 'cust_002', name: 'Bob Chen',           phone: '+15552001002', service_address: '202 Pine St, McAllen TX 78501',    plan_type: 'standard', plan_name: 'Standard Care',       expires_at: addDays(now, 18), renewal_outreach_count: 0 },
    { id: 'cust_003', name: 'Carol Davis',        phone: '+15552001003', service_address: '303 Maple Ave, Mission TX 78572',  plan_type: 'basic',    plan_name: 'Basic Coverage',     expires_at: addDays(now, 25), renewal_outreach_count: 1 },
    { id: 'cust_004', name: 'Derek Williams',      phone: '+15552001004', service_address: '404 Cedar Dr, Pharr TX 78577',     plan_type: 'premium',  plan_name: 'Elite Protection',  expires_at: addDays(now, 45), renewal_outreach_count: 0 },
    { id: 'cust_005', name: 'Elena Rodriguez',    phone: '+15552001005', service_address: '505 Elm St, San Juan TX 78589',   plan_type: 'standard', plan_name: 'Standard Care',      expires_at: addDays(now, 8),  renewal_outreach_count: 0 },
  ];

  const daysNotice = Number(process.env.RENEWAL_DAYS_NOTICE ?? 30);
  const cutoff = addDays(now, daysNotice);

  return plans.filter(p => new Date(p.expires_at) <= cutoff && p.renewal_outreach_count < 3);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function log(msg, data = {}) {
  console.log(`[${new Date().toISOString()}] ${msg}`, JSON.stringify(data));
}

// ── Twilio SMS ─────────────────────────────────────────────────────────────────

/**
 * Send an SMS via Twilio REST API (no SDK required).
 * @returns {Promise<string>} message SID
 */
async function sendTwilioSms(to, body) {
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
  log('SMS sent', { to, sid: data.sid });
  return data.sid;
}

// ── Dry-run mode ───────────────────────────────────────────────────────────────

function isDryRun() {
  return process.env.RENEWAL_DRY_RUN === 'true';
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log('L5 Renewal Cron starting');

  const tenantId   = process.env.DEFAULT_TENANT_ID ?? 'default';
  const maxDaily   = Number(process.env.MAX_DAILY_OUTREACH ?? 50);

  // Initialize FSM adapter (Jobber or Mock)
  let fsmAdapter = null;
  try {
    await initializeAdapters();
    fsmAdapter = getAdapter();
    log('FSM adapter ready', { adapter: fsmAdapter.constructor.name });
  } catch (err) {
    log('FSM adapter init failed — continuing without FSM', { error: err.message });
  }

  // Instantiate the outreach engine
  const engine = new RenewalOutreachEngine({
    queueStore: { enqueue, updateEntry },
    fsmAdapter,
    tenantId,
    tenantSlug: tenantId,
    logger: log,
  });

  // Find candidates
  const candidates = getMockRenewalCandidates();
  log(`Found ${candidates.length} renewal candidates`, {
    dryRun: isDryRun(),
    maxDaily,
    candidates: candidates.map(c => ({ id: c.id, name: c.name, expires: c.expires_at })),
  });

  if (candidates.length === 0) {
    log('No outreach needed today');
    return;
  }

  // Slice to daily cap
  const batch = candidates.slice(0, maxDaily);
  log(`Sending ${batch.length} messages (capped at ${maxDaily})`);

  // Build sendSms function
  const sendFn = isDryRun()
    ? async (to, body) => { log('DRY RUN — would send SMS', { to, body: body.slice(0, 60) }); return 'DRY_RUN_SID'; }
    : sendTwilioSms;

  // Run the campaign
  const results = await engine.runRenewalCampaign(batch, { sendSms: sendFn });

  log(`Campaign complete — ${results.length} messages processed`, {
    results: results.map(r => ({ phone: r.phone, entryId: r.entryId })),
  });

  // Summary
  const sent     = results.length;
  const failed    = 0; // runRenewalCampaign doesn't return per-recipient errors in v1
  log(`Renewal outreach done — sent: ${sent}, failed: ${failed}`);

  return results;
}

main().then(results => {
  console.log('\n--- RESULT ---');
  console.log(JSON.stringify({ success: true, count: results?.length ?? 0 }, null, 2));
  process.exit(0);
}).catch(err => {
  log('Renewal cron FAILED', { error: err.message, stack: err.stack });
  console.error('\n--- ERROR ---');
  console.error(err.message);
  process.exit(1);
});
