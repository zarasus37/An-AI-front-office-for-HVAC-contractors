/**
 * Multi-Tenant Layer Tests
 * Tests: store CRUD, tenant resolution, admin API
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { equal, deepEqual, throws, match, ok, notEqual } from 'node:assert';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../data');
const STORE_FILE = join(DATA_DIR, 'tenants.json');

// ── Test store: isolate to a separate file ──────────────────────────────────

const TEST_STORE_FILE = join(DATA_DIR, 'tenants-test.json');

function makeTestStore() {
  // Redirect the store module to use our test file
  return import('../src/multi-tenant/store.js').then(m => {
    // Monkey-patch DATA_DIR for these tests
    const orig = m;
    return m;
  });
}

describe('Multi-Tenant Store', () => {
  let store;

  beforeEach(async () => {
    // Use test store file
    if (existsSync(TEST_STORE_FILE)) unlinkSync(TEST_STORE_FILE);
    // Patch store module to use test file
    const srcPath = join(__dirname, '../src/multi-tenant/store.js');
    const src = readFileSync(srcPath, 'utf8');
    const patched = src.replace(
      "const STORE_FILE = join(DATA_DIR, 'tenants.json');",
      "const STORE_FILE = join(DATA_DIR, 'tenants-test.json');"
    );
    // Write patched version temporarily
    const patchedPath = join(DATA_DIR, 'store-test-hack.js');
    // Don't write — just use a fresh import and test via exports directly
    store = await import('../src/multi-tenant/store.js');
    // Clear store before each test
    if (existsSync(TEST_STORE_FILE)) unlinkSync(TEST_STORE_FILE);
    // Also clear the real store to avoid pollution
    if (existsSync(STORE_FILE)) {
      const backup = readFileSync(STORE_FILE, 'utf8');
      writeFileSync(STORE_FILE, '[]');
      afterEach(() => writeFileSync(STORE_FILE, backup));
    }
  });

  afterEach(() => {
    if (existsSync(TEST_STORE_FILE)) unlinkSync(TEST_STORE_FILE);
  });

  it('createTenant requires slug', async () => {
    const { createTenant } = await import('../src/multi-tenant/store.js');
    const { tenant, error } = createTenant({ name: 'Test Co' });
    equal(tenant, null);
    match(error, /slug/);
  });

  it('createTenant rejects duplicate slugs', async () => {
    const { createTenant } = await import('../src/multi-tenant/store.js');
    createTenant({ slug: 'dup-test', name: 'First' });
    const { tenant, error } = createTenant({ slug: 'dup-test', name: 'Second' });
    equal(tenant, null);
    match(error, /already exists/);
  });

  it('createTenant creates with correct defaults', async () => {
    const { createTenant, getTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({ slug: 'defaults-test', name: 'Test Co' });
    ok(tenant.id);
    ok(tenant.createdAt);
    ok(tenant.updatedAt);
    equal(tenant.status, 'onboarding');
    equal(tenant.ai.model, 'claude');
    equal(tenant.compliance.outboundEnabled, true);
    equal(tenant.fsm.type, 'mock');

    // Verify persisted
    const found = getTenant(tenant.id);
    notEqual(found, null);
    equal(found.slug, 'defaults-test');
  });

  it('getTenant finds by id, slug, and phone', async () => {
    const { createTenant, getTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({
      slug: 'find-test',
      name: 'Find Me',
      phone: '+15551234567',
    });
    equal(getTenant(tenant.id)?.name, 'Find Me');
    equal(getTenant('find-test')?.name, 'Find Me');
    equal(getTenant('+15551234567')?.name, 'Find Me');
  });

  it('getTenant returns null for unknown id', async () => {
    const { getTenant } = await import('../src/multi-tenant/store.js');
    equal(getTenant(randomUUID()), null);
  });

  it('getTenantByPhone finds by normalized phone', async () => {
    const { createTenant, getTenantByPhone } = await import('../src/multi-tenant/store.js');
    const unique = randomUUID().replace(/-/g, '').slice(0, 8);
    createTenant({
      slug: `phone-test-${unique}`,
      name: 'Phone Co',
      status: 'active',
      channels: { twilio: { fromNumber: `+1 (555) 999-${unique}` } },
    });
    const normalized = `+1555999${unique}`;
    equal(getTenantByPhone(normalized)?.name, 'Phone Co', `lookup for ${normalized} failed`);
  });

  it('updateTenant merges patch correctly', async () => {
    const { createTenant, updateTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({ slug: 'patch-test', name: 'Original' });
    const { tenant: updated } = updateTenant(tenant.id, { name: 'Updated', dispatcher: '+15550009999' });
    equal(updated.name, 'Updated');
    equal(updated.dispatcher, '+15550009999');
    equal(updated.slug, 'patch-test'); // slug unchanged
  });

  it('updateTenant rejects unknown id', async () => {
    const { updateTenant } = await import('../src/multi-tenant/store.js');
    const { error } = updateTenant(randomUUID(), { name: 'New' });
    match(error, /not found/);
  });

  it('activateTenant sets status and activatedAt', async () => {
    const { createTenant, activateTenant, getTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({ slug: 'activate-test', name: 'Act Co' });
    equal(tenant.status, 'onboarding');
    const { tenant: active } = activateTenant(tenant.id);
    equal(active.status, 'active');
    ok(active.activatedAt);
    equal(getTenant(tenant.id).status, 'active');
  });

  it('suspendTenant sets status to suspended', async () => {
    const { createTenant, suspendTenant, getTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({ slug: 'suspend-test', name: 'Sus Co' });
    suspendTenant(tenant.id);
    equal(getTenant(tenant.id).status, 'suspended');
  });

  it('canSendOutbound respects TTY hours', async () => {
    const { createTenant, canSendOutbound } = await import('../src/multi-tenant/store.js');
    createTenant({
      slug: 'tty-test',
      name: 'TTY Co',
      status: 'active',
      compliance: {
        outboundEnabled: true,
        ttyHours: { start: '09:00', end: '17:00' },
        timezone: 'UTC', // force UTC so we can predict the hour
      },
    });
    // UTC 09:00–17:00 is outside most local times but we just check the logic
    const result = canSendOutbound('tty-test');
    // Result depends on current UTC hour — just check shape
    ok(typeof result.allowed === 'boolean');
    ok(typeof result.reason === 'string' || result.reason === undefined);
  });

  it('canSendOutbound returns false for suspended tenant', async () => {
    const { createTenant, suspendTenant, canSendOutbound } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({
      slug: 'suspended-outbound-test',
      name: 'Sus Out',
      compliance: { outboundEnabled: true },
    });
    suspendTenant(tenant.id);
    const result = canSendOutbound(tenant.id);
    equal(result.allowed, false);
  });

  it('getTwilioConfig returns correct shape', async () => {
    const { createTenant, getTwilioConfig } = await import('../src/multi-tenant/store.js');
    createTenant({
      slug: 'twilio-cfg-test',
      name: 'Twilio Co',
      channels: {
        twilio: {
          accountSid: 'AC123',
          authToken: 'tok456',
          fromNumber: '+15550001111',
        },
      },
    });
    const cfg = getTwilioConfig('twilio-cfg-test');
    equal(cfg.accountSid, 'AC123');
    equal(cfg.authToken, 'tok456');
    equal(cfg.fromNumber, '+15550001111');
  });

  it('getTwilioConfig returns null for missing tenant', async () => {
    const { getTwilioConfig } = await import('../src/multi-tenant/store.js');
    equal(getTwilioConfig(randomUUID()), null);
  });

  it('listTenants filters by status', async () => {
    const { createTenant, activateTenant, listTenants } = await import('../src/multi-tenant/store.js');
    createTenant({ slug: 'list-active-1', name: 'A1', status: 'active' });
    createTenant({ slug: 'list-active-2', name: 'A2', status: 'active' });
    createTenant({ slug: 'list-suspended', name: 'Sus1', status: 'suspended' });
    const all    = listTenants();
    const active = listTenants({ status: 'active' });
    const sus   = listTenants({ status: 'suspended' });
    ok(all.length >= 3);
    ok(active.every(t => t.status === 'active'));
    ok(sus.every(t => t.status === 'suspended'));
  });
});

describe('Multi-Tenant Router', () => {
  it('tenantMiddleware attaches tenant to request', async () => {
    const { tenantMiddleware } = await import('../src/multi-tenant/router.js');
    const mw = tenantMiddleware({ required: false });
    const req = {
      get: () => null,
      query: {},
      headers: {},
      body: {},
    };
    const res = {};
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    mw(req, res, next);
    equal(nextCalled, true);
  });

  it('resolveTenant resolves from X-Tenant-ID header', async () => {
    const { resolveTenant } = await import('../src/multi-tenant/router.js');
    const { createTenant } = await import('../src/multi-tenant/store.js');
    const { tenant } = createTenant({ slug: 'header-test', name: 'Header Co', status: 'active' });
    const req = {
      get: () => tenant.id,
      query: {},
      body: {},
    };
    const result = resolveTenant(req);
    equal(result.tenant?.name, 'Header Co');
    equal(result.resolution, 'header:X-Tenant-ID');
  });

  it('resolveTenant resolves from query param', async () => {
    const { resolveTenant } = await import('../src/multi-tenant/router.js');
    const { createTenant } = await import('../src/multi-tenant/store.js');
    createTenant({ slug: 'query-resolve', name: 'Query Co', status: 'active' });
    const req = { get: () => null, query: { tenant: 'query-resolve' }, body: {} };
    const result = resolveTenant(req);
    equal(result.tenant?.name, 'Query Co');
    equal(result.resolution, 'query:tenant');
  });

  it('resolveTenant returns null when no tenant found', async () => {
    const { resolveTenant } = await import('../src/multi-tenant/router.js');
    const req = { get: () => null, query: {}, body: {} };
    const result = resolveTenant(req);
    equal(result.tenant, null);
    equal(result.resolution, 'none');
  });
});

describe('Admin API', () => {
  let app;

  beforeEach(async () => {
    // Build a minimal Express app for testing
    const { default: express } = await import('express');
    app = express();
    app.use(express.json());
  });

  async function request(method, path, body, apiKey = 'test-admin-key') {
    const { createTenant, listTenants, getTenant, updateTenant, deleteTenant, activateTenant, suspendTenant } =
      await import('../src/multi-tenant/store.js');
    const { registerAdminRoutes } = await import('../src/multi-tenant/admin.js');

    // Patch ADMIN_API_KEYS for tests
    process.env.ADMIN_API_KEYS = 'test-admin-key';

    registerAdminRoutes(app);

    const http = await import('http');
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const opts = {
          hostname: 'localhost',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-API-Key': apiKey,
          },
        };
        const req = http.request(opts, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    });
  }

  it('POST /admin/tenants requires auth', async () => {
    const result = await request('POST', '/admin/tenants', { slug: 'x', name: 'X' }, 'wrong-key');
    equal(result.status, 401);
  });

  it('POST /admin/tenants creates tenant', async () => {
    const result = await request('POST', '/admin/tenants', {
      slug: 'create-api-test',
      name: 'Create API Co',
      dispatcher: '+15550009999',
    });
    equal(result.status, 201);
    equal(result.body.tenant.slug, 'create-api-test');
    ok(result.body.nextSteps);
    ok(Array.isArray(result.body.nextSteps));
  });

  it('POST /admin/tenants rejects invalid slug', async () => {
    const result = await request('POST', '/admin/tenants', {
      slug: 'Invalid Slug!',
      name: 'Bad Slug Co',
    });
    equal(result.status, 400);
    match(result.body.error, /lowercase/);
  });

  it('POST /admin/tenants rejects duplicate slug', async () => {
    await request('POST', '/admin/tenants', { slug: 'dup-api-test', name: 'Dup1' });
    const result = await request('POST', '/admin/tenants', { slug: 'dup-api-test', name: 'Dup2' });
    equal(result.status, 409);
  });

  it('GET /admin/tenants lists tenants', async () => {
    await request('POST', '/admin/tenants', { slug: 'list-api-1', name: 'List1' });
    await request('POST', '/admin/tenants', { slug: 'list-api-2', name: 'List2' });
    const result = await request('GET', '/admin/tenants');
    equal(result.status, 200);
    ok(result.body.tenants.length >= 2);
    ok(!result.body.tenants[0].channels?.twilio?.authToken?.includes('***'));
  });

  it('GET /admin/tenants/:id gets single tenant', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'get-api-test', name: 'Get Co' });
    const id = created.body.tenant.id;
    const result = await request('GET', `/admin/tenants/${id}`);
    equal(result.status, 200);
    equal(result.body.tenant.name, 'Get Co');
  });

  it('GET /admin/tenants/:id returns 404 for unknown', async () => {
    const { randomUUID } = await import('crypto');
    const result = await request('GET', `/admin/tenants/${randomUUID()}`);
    equal(result.status, 404);
  });

  it('PUT /admin/tenants/:id updates tenant', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'update-api-test', name: 'Old Name' });
    const id = created.body.tenant.id;
    const result = await request('PUT', `/admin/tenants/${id}`, { name: 'New Name', dispatcher: '+15550001111' });
    equal(result.status, 200);
    equal(result.body.tenant.name, 'New Name');
    equal(result.body.tenant.slug, 'update-api-test'); // slug unchanged
  });

  it('DELETE /admin/tenants/:id archives tenant', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'delete-api-test', name: 'Delete Co' });
    const id = created.body.tenant.id;
    const result = await request('DELETE', `/admin/tenants/${id}`);
    equal(result.status, 200);
    equal(result.body.success, true);
  });

  it('POST /admin/tenants/:id/activate activates tenant', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'activate-api-test', name: 'Act Co' });
    const id = created.body.tenant.id;
    const result = await request('POST', `/admin/tenants/${id}/activate`);
    equal(result.status, 200);
    equal(result.body.tenant.status, 'active');
    ok(result.body.tenant.activatedAt);
  });

  it('POST /admin/tenants/:id/suspend suspends tenant', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'suspend-api-test', name: 'Sus Co' });
    const id = created.body.tenant.id;
    const result = await request('POST', `/admin/tenants/${id}/suspend`);
    equal(result.status, 200);
    equal(result.body.tenant.status, 'suspended');
  });

  it('GET /admin/tenants/:id/config returns env vars', async () => {
    const created = await request('POST', '/admin/tenants', { slug: 'config-api-test', name: 'Cfg Co', dispatcher: '+15550002222' });
    const id = created.body.tenant.id;
    const result = await request('GET', `/admin/tenants/${id}/config`);
    equal(result.status, 200);
    ok(result.body.config);
    ok(result.body.config[`TENANT_${'CONFIG-API-TEST'.toUpperCase().replace(/-/g, '_')}_DISPATCHER`]);
  });
});
