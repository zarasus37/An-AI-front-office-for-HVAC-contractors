/**
 * Layer 0 — Multi-Tenant Configuration Store
 *
 * JSON file-backed tenant registry. Swappable for Postgres/Supabase in prod.
 * Each tenant = one HVAC contractor.
 *
 * Schema:
 * {
 *   id:          string,          // uuid
 *   slug:        string,          // url-safe unique identifier, e.g. "acme-hvac"
 *   name:        string,          // display name
 *   status:      'active' | 'suspended' | 'onboarding',
 *   phone:       string,          // primary business phone (E.164)
 *   address:     string,          // business address
 *   dispatcher:  string,          // cell for emergency escalation (E.164)
 *   channels: {
 *     twilio: {
 *       accountSid:  string,
 *       authToken:   string,      // encrypted in prod
 *       fromNumber:  string,      // E.164
 *     },
 *     webWidget: {
 *       enabled:    boolean,
 *       domain:     string,       // allowed origin, e.g. "acme-hvac.com"
 *     }
 *   },
 *   fsm: {
 *     type:       'jobber' | 'hcp' | 'servicetitan' | 'mock',
 *     credentials: {              // encrypted in prod, decrypted at runtime
 *       accessToken?: string,
 *       subdomain?:  string,
 *       apiKey?:     string,
 *     }
 *   },
 *   ai: {
 *     model:      'claude' | 'ollama',
 *     modelName:  string,         // e.g. "claude-sonnet-4" or "deepseek-v4-flash"
 *     systemPromptOverride?: string,
 *     escalationThreshold: 'emergency' | 'urgent' | 'all',
 *   },
 *   pricebook: {
 *     laborRate:        number,   // $/hour
 *     tripCharge:       number,   // $
 *     dispatchFee:      number,   // $
 *     serviceTypes: [{            // service_type -> base price mapping
 *       type:   string,          // e.g. "repair", "maintenance", "installation"
 *       label:  string,
 *       basePrice: number,
 *     }]
 *   },
 *   compliance: {
 *     outboundEnabled: boolean,
 *     ttyHours: { start: string, end: string }, // "08:00"-"18:00"
 *     timezone: string,
 *   },
 *   createdAt: string,           // ISO 8601
 *   updatedAt: string,
 *   activatedAt: string | null,
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../../data');
const STORE_FILE = join(DATA_DIR, 'tenants.json');

// ── Init ──────────────────────────────────────────────────────────────────────

function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(STORE_FILE)) writeFileSync(STORE_FILE, JSON.stringify([], null, 2));
}

function readStore() {
  ensureStore();
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'));
}

function writeStore(tenants) {
  writeFileSync(STORE_FILE, JSON.stringify(tenants, null, 2));
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * List all tenants. Pass status to filter.
 * @param {{ status?: string }} opts
 * @returns {object[]}
 */
export function listTenants(opts = {}) {
  const tenants = readStore();
  if (opts.status) return tenants.filter(t => t.status === opts.status);
  return tenants;
}

/**
 * Get a single tenant by id or slug.
 * @param {string} idOrSlug
 * @returns {object|null}
 */
export function getTenant(idOrSlug) {
  const tenants = readStore();
  return tenants.find(t =>
    t.id === idOrSlug || t.slug === idOrSlug || t.phone === idOrSlug
  ) ?? null;
}

/**
 * Get active tenant by phone number (for inbound SMS/voice resolution).
 * Matches on channels.twilio.fromNumber.
 * @param {string} phone  E.164
 * @returns {object|null}
 */
export function getTenantByPhone(phone) {
  const tenants = readStore();
  return tenants.find(t =>
    t.status === 'active' &&
    t.channels?.twilio?.fromNumber?.replace(/\D/g, '') === phone.replace(/\D/g, '')
  ) ?? null;
}

/**
 * Get active tenant by domain (for web widget origin check).
 * @param {string} domain  e.g. "acme-hvac.com"
 * @returns {object|null}
 */
export function getTenantByDomain(domain) {
  const tenants = readStore();
  return tenants.find(t =>
    t.status === 'active' &&
    t.channels?.webWidget?.domain?.toLowerCase() === domain.toLowerCase()
  ) ?? null;
}

/**
 * Create a new tenant. Slug must be unique.
 * @param {object} data  — all fields except id, createdAt, updatedAt
 * @returns {{ tenant: object, error: string|null }}
 */
export function createTenant(data) {
  const tenants = readStore();

  if (!data.slug) return { tenant: null, error: 'slug is required' };
  if (tenants.some(t => t.slug === data.slug))
    return { tenant: null, error: `slug "${data.slug}" already exists` };

  const now = new Date().toISOString();

  // Build clean object — spread data FIRST so per-field defaults can override
  const defaults = {
    status:      'onboarding',
    channels:    { twilio: {}, webWidget: {} },
    fsm:        { type: 'mock', credentials: {} },
    ai:         { model: 'claude', modelName: 'claude-sonnet-4', escalationThreshold: 'emergency' },
    pricebook:  { laborRate: 95, tripCharge: 59, dispatchFee: 0, serviceTypes: [] },
    compliance:  { outboundEnabled: true, ttyHours: { start: '08:00', end: '18:00' }, timezone: 'America/Chicago' },
  };

  const final = {
    id:          randomUUID(),
    status:      data.status      ?? defaults.status,
    createdAt:   now,
    updatedAt:   now,
    activatedAt: null,
    name:        data.name        ?? '',
    slug:        data.slug,
    phone:       data.phone       ?? '',
    address:     data.address     ?? '',
    dispatcher:  data.dispatcher  ?? '',
    channels:    data.channels    ?? defaults.channels,
    fsm:        data.fsm         ?? defaults.fsm,
    ai:         data.ai           ?? defaults.ai,
    pricebook:  data.pricebook   ?? defaults.pricebook,
    compliance:  data.compliance ?? defaults.compliance,
  };

  tenants.push(final);
  writeStore(tenants);
  return { tenant: final, error: null };
}

/**
 * Update a tenant. Partial update — merges with existing.
 * @param {string} id
 * @param {object} patch
 * @returns {{ tenant: object|null, error: string|null }}
 */
export function updateTenant(id, patch) {
  const tenants = readStore();
  const idx = tenants.findIndex(t => t.id === id);
  if (idx === -1) return { tenant: null, error: 'tenant not found' };

  // Prevent changing certain fields
  delete patch.id;
  delete patch.createdAt;

  const updated = {
    ...tenants[idx],
    ...patch,
    id:          tenants[idx].id,
    createdAt:   tenants[idx].createdAt,
    updatedAt:   new Date().toISOString(),
  };

  tenants[idx] = updated;
  writeStore(tenants);
  return { tenant: updated, error: null };
}

/**
 * Activate a tenant (transition from onboarding → active).
 * @param {string} id
 * @returns {{ tenant: object|null, error: string|null }}
 */
export function activateTenant(id) {
  return updateTenant(id, { status: 'active', activatedAt: new Date().toISOString() });
}

/**
 * Suspend a tenant.
 * @param {string} id
 * @returns {{ tenant: object|null, error: string|null }}
 */
export function suspendTenant(id) {
  return updateTenant(id, { status: 'suspended' });
}

/**
 * Delete a tenant (soft delete — sets status to archived).
 * @param {string} id
 * @returns {{ success: boolean, error: string|null }}
 */
export function deleteTenant(id) {
  const result = updateTenant(id, { status: 'archived' });
  return { success: !result.error, error: result.error };
}

/**
 * Resolve Twilio credentials for a tenant.
 * Convenience wrapper — decrypts in prod.
 * @param {string} tenantId
 * @returns {{ accountSid: string, authToken: string, fromNumber: string }|null}
 */
export function getTwilioConfig(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant || !tenant.channels?.twilio) return null;
  const tw = tenant.channels.twilio;
  if (!tw.accountSid || !tw.authToken || !tw.fromNumber) return null;
  return {
    accountSid: tw.accountSid,
    authToken:  tw.authToken,
    fromNumber: tw.fromNumber,
  };
}

/**
 * Resolve FSM credentials for a tenant.
 * @param {string} tenantId
 * @returns {{ type: string, credentials: object }|null}
 */
export function getFsmConfig(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant || !tenant.fsm) return null;
  return { type: tenant.fsm.type, credentials: tenant.fsm.credentials ?? {} };
}

/**
 * Check if outbound is allowed for a tenant right now.
 * Respects ttyHours and outboundEnabled flag.
 * @param {string} tenantId
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canSendOutbound(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant) return { allowed: false, reason: 'tenant not found' };
  if (tenant.status !== 'active') return { allowed: false, reason: `tenant status is ${tenant.status}` };
  if (!tenant.compliance?.outboundEnabled) return { allowed: false, reason: 'outbound disabled' };

  const now = new Date();
  const tz  = tenant.compliance.timezone ?? 'America/Chicago';

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    });
    const parts   = formatter.formatToParts(now);
    const hour    = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const minute  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    const current = hour * 60 + minute;

    const [startH, startM] = (tenant.compliance.ttyHours?.start ?? '08:00').split(':').map(Number);
    const [endH,   endM]   = (tenant.compliance.ttyHours?.end   ?? '18:00').split(':').map(Number);
    const start = startH * 60 + startM;
    const end   = endH   * 60 + endM;

    if (current < start || current >= end) {
      return { allowed: false, reason: `outside TTY hours (${tenant.compliance.ttyHours.start}–${tenant.compliance.ttyHours.end})` };
    }
  } catch {
    // timezone解析失败，放行
    return { allowed: true };
  }

  return { allowed: true };
}
