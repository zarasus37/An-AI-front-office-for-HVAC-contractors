/**
 * Layer 0 — Tenant Onboarding Admin API
 *
 * Routes:
 *   POST   /admin/tenants          — Create + onboard new tenant
 *   GET    /admin/tenants           — List all tenants
 *   GET    /admin/tenants/:id       — Get tenant by id or slug
 *   PUT    /admin/tenants/:id       — Update tenant config
 *   DELETE /admin/tenants/:id       — Archive tenant
 *   POST   /admin/tenants/:id/activate  — Activate tenant
 *   POST   /admin/tenants/:id/suspend   — Suspend tenant
 *   GET    /admin/tenants/:id/config    — Get runtime config (env vars, no secrets)
 *
 * Auth: API key in X-Admin-API-Key header.
 *       In prod: verify against ADMIN_API_KEYS env var (comma-separated list).
 */

import { Router } from 'express';
import {
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  deleteTenant,
  activateTenant,
  suspendTenant,
  getTwilioConfig,
  getFsmConfig,
} from './store.js';
import { getAdapter } from '../fsm/router.js';
import { initializeAdapters } from '../fsm/router.js';

export function registerAdminRoutes(app) {
  const router = Router();
  app.use('/admin', router);

  // ── Auth middleware ──────────────────────────────────────────────────────

  function adminAuth(req, res, next) {
    const key = req.get('X-Admin-API-Key');
    const validKeys = (process.env.ADMIN_API_KEYS ?? '').split(',').filter(Boolean);
    if (!key || !validKeys.includes(key)) {
      return res.status(401).json({ error: 'Invalid or missing X-Admin-API-Key', code: 'UNAUTHORIZED' });
    }
    next();
  }

  // ── List ──────────────────────────────────────────────────────────────────

  router.get('/tenants', adminAuth, (req, res) => {
    const { status } = req.query;
    const tenants = listTenants({ status });
    // Strip secrets before returning
    const safe = tenants.map(sanitizeTenant);
    res.json({ tenants: safe, count: safe.length });
  });

  // ── Get ───────────────────────────────────────────────────────────────────

  router.get('/tenants/:id', adminAuth, (req, res) => {
    const tenant = getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found', code: 'NOT_FOUND' });
    res.json({ tenant: sanitizeTenant(tenant) });
  });

  // ── Create ───────────────────────────────────────────────────────────────

  router.post('/tenants', adminAuth, async (req, res) => {
    const { slug, name, phone, dispatcher, channels, fsm, ai, pricebook, compliance } = req.body;

    if (!slug) return res.status(400).json({ error: 'slug is required', code: 'VALIDATION_ERROR' });
    if (!name) return res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({
        error: 'slug must be lowercase alphanumeric with hyphens only',
        code: 'VALIDATION_ERROR',
      });
    }

    const { tenant, error } = createTenant({
      slug, name, phone, dispatcher,
      channels, fsm, ai, pricebook, compliance,
    });

    if (error) {
      const status = error.includes('already exists') ? 409 : 400;
      return res.status(status).json({ error, code: 'VALIDATION_ERROR' });
    }

    res.status(201).json({
      tenant: sanitizeTenant(tenant),
      nextSteps: buildOnboardingChecklist(tenant),
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────

  router.put('/tenants/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    const allowed = [
      'name', 'phone', 'address', 'dispatcher',
      'channels', 'fsm', 'ai', 'pricebook', 'compliance', 'status',
    ];
    const patch = Object.keys(req.body)
      .filter(k => allowed.includes(k))
      .reduce((acc, k) => ({ ...acc, [k]: req.body[k] }), {});

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update', code: 'VALIDATION_ERROR' });
    }

    const { tenant, error } = updateTenant(id, patch);
    if (error) return res.status(404).json({ error, code: 'NOT_FOUND' });

    res.json({ tenant: sanitizeTenant(tenant) });
  });

  // ── Delete / Archive ─────────────────────────────────────────────────────

  router.delete('/tenants/:id', adminAuth, (req, res) => {
    const { success, error } = deleteTenant(req.params.id);
    if (!success) return res.status(404).json({ error, code: 'NOT_FOUND' });
    res.json({ success: true, message: 'Tenant archived' });
  });

  // ── Activate ────────────────────────────────────────────────────────────

  router.post('/tenants/:id/activate', adminAuth, async (req, res) => {
    const { tenant, error } = activateTenant(req.params.id);
    if (error) return res.status(404).json({ error, code: 'NOT_FOUND' });

    // Validate that tenant has required fields before activating
    const missing = getMissingActivationFields(tenant);
    if (missing.length > 0) {
      // Still activate — missing fields are warnings
      res.status(200).json({
        tenant: sanitizeTenant(tenant),
        warnings: missing.map(f => `Missing field: ${f}`),
      });
    } else {
      res.json({ tenant: sanitizeTenant(tenant) });
    }
  });

  // ── Suspend ─────────────────────────────────────────────────────────────

  router.post('/tenants/:id/suspend', adminAuth, (req, res) => {
    const { tenant, error } = suspendTenant(req.params.id);
    if (error) return res.status(404).json({ error, code: 'NOT_FOUND' });
    res.json({ tenant: sanitizeTenant(tenant) });
  });

  // ── Runtime config (no secrets) ──────────────────────────────────────────

  router.get('/tenants/:id/config', adminAuth, async (req, res) => {
    const tenant = getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found', code: 'NOT_FOUND' });

    // Build env var config for Railway / deployment
    const runtimeConfig = buildRuntimeEnvVars(tenant);
    res.json({ tenantId: tenant.id, config: runtimeConfig });
  });

  // ── Test FSM connection ────────────────────────────────────────────────────

  router.post('/tenants/:id/test-fsm', adminAuth, async (req, res) => {
    const tenant = getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found', code: 'NOT_FOUND' });

    try {
      await initializeAdapters();
      const adapter = getAdapter();
      if (!adapter) throw new Error('No FSM adapter available');

      // Test: try to find a dummy customer
      const result = await adapter.findCustomer('+15550000000', null);
      res.json({
        ok: true,
        adapter: adapter.name,
        result: result ?? 'no customer found (expected)',
      });
    } catch (err) {
      res.status(200).json({
        ok: false,
        error: err.message,
        hint: 'Check FSM credentials in channels.fsm.credentials',
      });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip sensitive fields before returning to admin */
function sanitizeTenant(tenant) {
  if (!tenant) return null;
  const s = { ...tenant };
  // Mask Twilio auth token
  if (s.channels?.twilio?.authToken) {
    s.channels.twilio = { ...s.channels.twilio, authToken: mask(s.channels.twilio.authToken) };
  }
  // Mask FSM credentials
  if (s.fsm?.credentials) {
    const creds = { ...s.fsm.credentials };
    for (const k of Object.keys(creds)) {
      if (creds[k] && typeof creds[k] === 'string') creds[k] = mask(creds[k]);
    }
    s.fsm = { ...s.fsm, credentials: creds };
  }
  return s;
}

function mask(str) {
  if (!str || str.length < 6) return '***';
  return str.slice(0, 3) + '***' + str.slice(-3);
}

/** Fields required before a tenant can be safely activated */
function getMissingActivationFields(tenant) {
  const missing = [];
  if (!tenant.slug)                              missing.push('slug');
  if (!tenant.dispatcher)                        missing.push('dispatcher');
  if (!tenant.channels?.twilio?.accountSid)      missing.push('channels.twilio.accountSid');
  if (!tenant.channels?.twilio?.fromNumber)      missing.push('channels.twilio.fromNumber');
  if (!tenant.ai?.model)                         missing.push('ai.model');
  return missing;
}

/** Build a checklist of what the contractor still needs to do after creation */
function buildOnboardingChecklist(tenant) {
  const steps = [];

  steps.push({
    step: 1,
    label: 'Configure Twilio webhooks',
    detail: `Point your Twilio phone number's SMS webhook at:
             https://hvac-ai.up.railway.app/sms?tenant=${tenant.slug}
             And Voice Status Callback to:
             https://hvac-ai.up.railway.app/voice?tenant=${tenant.slug}`,
    done: false,
  });

  if (!tenant.channels?.twilio?.accountSid) {
    steps.push({ step: 2, label: 'Add Twilio credentials', detail: 'POST /admin/tenants/:id with channels.twilio', done: false });
  }

  if (!tenant.fsm?.credentials?.accessToken) {
    steps.push({ step: 3, label: 'Connect FSM (Jobber/HCP)', detail: 'POST /admin/tenants/:id with fsm credentials', done: false });
  } else {
    steps.push({ step: 3, label: 'Connect FSM (Jobber/HCP)', done: true });
  }

  if (!tenant.dispatcher) {
    steps.push({ step: 4, label: 'Set dispatcher phone', detail: 'PUT /admin/tenants/:id with dispatcher field', done: false });
  }

  steps.push({
    step: 5,
    label: 'Activate tenant',
    detail: `POST /admin/tenants/${tenant.id}/activate`,
    done: tenant.status === 'active',
  });

  return steps;
}

/** Build env var map for deploying a tenant (used by deployment tooling) */
function buildRuntimeEnvVars(tenant) {
  const vars = {};
  vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_ID`]          = tenant.id;
  vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_SLUG`]        = tenant.slug;
  vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_DISPATCHER`]   = tenant.dispatcher ?? '';

  if (tenant.channels?.twilio) {
    vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_TWILIO_SID`]  = tenant.channels.twilio.accountSid ?? '';
    vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_TWILIO_FROM`] = tenant.channels.twilio.fromNumber ?? '';
    // Note: auth token should go in Key Vault / secrets manager, not plain env
  }

  if (tenant.fsm?.type && tenant.fsm.type !== 'mock') {
    vars[`TENANT_${tenant.slug.toUpperCase().replace(/-/g, '_')}_FSM_TYPE`]   = tenant.fsm.type;
  }

  return vars;
}
