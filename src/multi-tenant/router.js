/**
 * Layer 0 — Multi-Tenant Resolution Router
 *
 * Resolves which tenant is handling an incoming request.
 * Used by all channel handlers (web, sms, voice) and the admin API.
 *
 * Resolution priority:
 *   1. Subdomain          — ?tenant=acme-hvac query param or subdomain
 *   2. Twilio from number — inbound SMS/voice matched to tenant's fromNumber
 *   3. Web origin/domain  — request Host or Origin header matched to tenant's webWidget domain
 *   4. API key header     — X-Tenant-ID header (for server-to-server)
 *   5. Default tenant     — FALLBACK to DEFAULT_TENANT_SLUG env var
 *
 * If no tenant found → reject with 403.
 */

import { getTenant, getTenantByPhone, getTenantByDomain } from './store.js';

/**
 * Resolve tenant from an Express request.
 * Never throws — returns null if no tenant found.
 *
 * @param {import('express').Request} req
 * @returns {{ tenant: object|null, resolution: string }}
 */
export function resolveTenant(req) {
  // 1. Explicit tenant ID header (server-to-server)
  const headerTenant = req.get('X-Tenant-ID');
  if (headerTenant) {
    const tenant = getTenant(headerTenant);
    if (tenant && tenant.status === 'active') {
      return { tenant, resolution: 'header:X-Tenant-ID' };
    }
  }

  // 2. Query param (web widget embeds ?tenant=acme-hvac)
  const queryTenant = req.query?.tenant ?? req.query?.tenant_id;
  if (queryTenant) {
    const tenant = getTenant(queryTenant);
    if (tenant && tenant.status === 'active') {
      return { tenant, resolution: 'query:tenant' };
    }
  }

  // 3. Subdomain (e.g. acme.hvac.ai → tenant=acme)
  const host = req.get('Host') ?? '';
  const [subdomain] = host.split('.')[0] ?? [];
  if (subdomain && subdomain !== 'www' && subdomain !== 'hvac-ai') {
    const tenant = getTenant(subdomain);
    if (tenant && tenant.status === 'active') {
      return { tenant, resolution: 'subdomain' };
    }
  }

  // 4. Web Origin header for cross-origin requests
  const origin = req.get('Origin') ?? '';
  if (origin) {
    try {
      const { hostname } = new URL(origin);
      const tenant = getTenantByDomain(hostname);
      if (tenant) {
        return { tenant, resolution: 'origin' };
      }
    } catch {
      // invalid origin, skip
    }
  }

  // 5. Twilio from number (inbound SMS/voice — from param in body)
  const fromPhone = req.body?.From ?? req.query?.From ?? req.query?.from;
  if (fromPhone) {
    const tenant = getTenantByPhone(fromPhone);
    if (tenant) {
      return { tenant, resolution: 'phone:From' };
    }
  }

  // 6. Default tenant fallback
  const defaultSlug = process.env.DEFAULT_TENANT_SLUG ?? 'default';
  const tenant = getTenant(defaultSlug);
  if (tenant && tenant.status === 'active') {
    return { tenant, resolution: 'fallback:DEFAULT_TENANT_SLUG' };
  }

  return { tenant: null, resolution: 'none' };
}

/**
 * Middleware factory — attaches resolved tenant to req.tenant.
 * Use: app.use(tenantMiddleware());
 *
 * @param {{ required?: boolean }} opts
 */
export function tenantMiddleware(opts = {}) {
  const { required = false } = opts;
  return (req, res, next) => {
    const { tenant, resolution } = resolveTenant(req);
    req._tenantResolution = resolution;
    if (tenant) {
      req.tenant = tenant;
      next();
    } else if (required) {
      res.status(403).json({
        error: 'Tenant not found',
        code:  'TENANT_NOT_FOUND',
        resolution,
      });
    } else {
      next();
    }
  };
}

/**
 * Per-channel tenant resolution with channel-specific fallbacks.
 *
 * @param {import('express').Request} req
 * @param {'web'|'sms'|'voice'|'api'} channel
 */
export function resolveTenantForChannel(req, channel) {
  // Web channel — prioritize origin/domain resolution
  if (channel === 'web') {
    const origin = req.get('Origin') ?? '';
    if (origin) {
      try {
        const { hostname } = new URL(origin);
        const tenant = getTenantByDomain(hostname);
        if (tenant) return { tenant, resolution: 'origin' };
      } catch { /* skip */ }
    }
    const queryTenant = req.query?.tenant ?? req.query?.tenant_id;
    if (queryTenant) {
      const tenant = getTenant(queryTenant);
      if (tenant && tenant.status === 'active') {
        return { tenant, resolution: 'query:tenant' };
      }
    }
  }

  // SMS/Voice — prioritize phone number resolution
  if (channel === 'sms' || channel === 'voice') {
    const fromPhone = req.body?.From ?? req.query?.From ?? req.query?.from;
    if (fromPhone) {
      const tenant = getTenantByPhone(fromPhone);
      if (tenant) return { tenant, resolution: 'phone:From' };
    }
  }

  // API — header first, then query
  if (channel === 'api') {
    const headerTenant = req.get('X-Tenant-ID');
    if (headerTenant) {
      const tenant = getTenant(headerTenant);
      if (tenant && tenant.status === 'active') {
        return { tenant, resolution: 'header:X-Tenant-ID' };
      }
    }
    const queryTenant = req.query?.tenant ?? req.query?.tenant_id;
    if (queryTenant) {
      const tenant = getTenant(queryTenant);
      if (tenant && tenant.status === 'active') {
        return { tenant, resolution: 'query:tenant' };
      }
    }
  }

  // Fallback to generic resolution
  return resolveTenant(req);
}
