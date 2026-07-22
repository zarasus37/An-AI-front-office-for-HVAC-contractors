/**
 * Server entry point
 * Run: node src/server.js  (uses ESM — no --experimental-modules flag needed with "type": "module" in package.json)
 */

import { createServer } from 'http';
import app from './app.js';
import { logger } from './utils/logger.js';
import { initializeAdapters } from './fsm/router.js';
import { flush as flushQueue } from './queue/store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const server = createServer(app);

server.listen(PORT, HOST, async () => {
  logger.info(`HVAC AI intake server running on http://${HOST}:${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV ?? 'development'}`);

  // Initialize FSM adapters (silently — may not be configured in dev)
  try {
    const results = await initializeAdapters();
    const configured = results.filter(r => r.status === 'ok').map(r => r.name);
    if (configured.length > 0) {
      logger.info(`FSM adapters ready: ${configured.join(', ')}`);
    }
  } catch (err) {
    logger.warn('FSM adapter init error:', err.message);
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Received ${signal} — closing server...`);
  // Flush queue snapshot before exiting so no leads are lost
  try {
    await flushQueue();
  } catch (e) {
    logger.warn('Queue flush error:', e.message);
  }
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
  // Force exit if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
