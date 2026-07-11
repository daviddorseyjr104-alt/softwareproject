// BOOT-ONLY configuration: values needed to start the process and secure it.
// Everything the client can change at runtime (API keys, scoring weights, the pool, dry-run)
// lives in src/settings.js instead — a durable, editable store the admin UI writes to.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function resolveDataDir(v) {
  const raw = v && v.trim() ? v.trim() : join(projectRoot, 'data');
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

export const bootConfig = {
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Auth + crypto secrets (host env / secret store only — never persisted to disk).
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  secretKey: process.env.SECRET_KEY || '',
  // Where durable state (settings.json, jobs.json, client pool) lives.
  dataDir: resolveDataDir(process.env.DATA_DIR),
  get isProduction() {
    return this.nodeEnv === 'production';
  },
};

/**
 * Boot-time safety check.
 * In production we REFUSE to start without the secrets — otherwise the endpoint is open and can
 * spend the client's API credits / send real email. In dev we only warn.
 * @returns {{fatal:string[], warnings:string[]}}
 */
export function bootSafety() {
  const fatal = [];
  const warnings = [];
  const need = [
    ['WEBHOOK_SECRET', bootConfig.webhookSecret, 'the webhook + admin API would be UNAUTHENTICATED'],
    ['ADMIN_PASSWORD', bootConfig.adminPassword, 'the settings UI would be unprotected'],
    ['SECRET_KEY', bootConfig.secretKey, 'API keys could not be stored encrypted at rest'],
  ];
  for (const [name, value, why] of need) {
    if (value) continue;
    if (bootConfig.isProduction) fatal.push(`${name} is required in production — ${why}.`);
    else warnings.push(`${name} is not set — ${why} (ok for local dev).`);
  }
  return { fatal, warnings };
}
