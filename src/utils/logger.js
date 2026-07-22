/**
 * Logger — structured audit logger for Layer 1 intake
 * Routes to console in dev; swap for Datadog/Splunk/etc. in prod.
 */

/** @type {'debug'|'info'|'warn'|'error'} */
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const handlers = {
  debug: (...args) => LOG_LEVEL === 'debug' && console.debug('[DEBUG]', ...args),
  info:  (...args) => ['debug','info'].includes(LOG_LEVEL) && console.log('[INFO]',  ...args),
  warn:  (...args) => console.warn('[WARN]',  ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

export const logger = {
  debug: (...args) => handlers.debug(...args),
  info:  (...args) => handlers.info(...args),
  warn:  (...args) => handlers.warn(...args),
  error: (...args) => handlers.error(...args),

  /** Always prints — use for audit/triage events */
  audit: (event, data) => {
    console.log(`[AUDIT ${event}]`, JSON.stringify(data));
  },
};
