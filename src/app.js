/**
 * Express app — Layer 1 omnichannel intake hub
 *
 * Mounts:
 *   POST /webhooks/sms/inbound   — Twilio SMS inbound
 *   POST /webhooks/voice         — Twilio voice inbound (CIPA)
 *   POST /webhooks/ecobee        — Ecobee IoT telemetry (Layer 4)
 *   GET  /web/chat              — widget config + JSON chat endpoint
 *   GET  /widget.js             — embeddable chat widget JS
 *   GET  /widget.css            — widget styles
 *   GET  /health                — liveness probe
 *   GET  /queue                 — list entries (dev only)
 */

import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { registerSmsRoutes }  from './channels/twilio-sms.js';
import { registerVoiceRoutes } from './channels/voice.js';
import { registerWebRoutes }  from './channels/web.js';
import { listEntries }         from './queue/store.js';
import { seedDevRegistry } from './iot/customer-registry.js';
import { consentStore } from './compliance/consent-store.js';
import { initializeAdapters, getAdapter } from './fsm/router.js';
import * as sessionStore from './conversation/session.js';
import * as queueStore from './queue/store.js';

// Seed dev registry on startup (dev/test only)
if (process.env.NODE_ENV !== 'production') {
  seedDevRegistry();
}

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));  // Twilio POST uses urlencoded
app.use(express.json());                           // JSON API support

// ── Serve static widget files ─────────────────────────────────────────────────
app.use(express.static(resolve(__dirname, '../public')));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Queue browser (dev only) ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.get('/queue', (req, res) => {
    const entries = listEntries({
      tenantId: req.query.tenant ?? null,
      status:   req.query.status  ?? null,
      limit:    Number(req.query.limit ?? 50),
    });
    res.json({ count: entries.length, entries });
  });
}

// ── Register channel routes ────────────────────────────────────────────────────
await registerSmsRoutes(app);
await registerVoiceRoutes(app);
await registerWebRoutes(app);

// ── IoT / Ecobee webhook (Layer 4 → queue + session) ──────────────────────────
app.post('/webhooks/ecobee', async (req, res) => {
  const { handleEcobeeWebhook } = await import('./iot/webhook.js');
  const adapter = getAdapter(process.env.DEFAULT_TENANT_SLUG ?? 'default');
  return handleEcobeeWebhook(req, res, {
    fsmAdapter:    adapter,
    queueStore:    { enqueue: queueStore.enqueue, updateEntry: queueStore.updateEntry, getEntry: queueStore.getEntry },
    sessionStore:  sessionStore,
    logger:        console.log,
  });
});

// ── 404 handler ────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[APP ERROR]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;
