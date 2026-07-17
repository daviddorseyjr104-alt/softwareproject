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
  /**
   * Anything that is not explicitly a dev/test box counts as production.
   *
   * The old check was `nodeEnv === 'production'`, which meant a host that merely forgot to set
   * NODE_ENV (a bare `npm start` on a VPS, `NODE_ENV=staging`) silently fell back to
   * 'development' — where missing secrets only warn, so the admin console, the webhook, and
   * live sending all came up wide open. Unrecognized must fail closed, not open.
   */
  get isProduction() {
    return !['development', 'test'].includes(this.nodeEnv);
  },
  /** Escape hatch for local dev without secrets. Must be set deliberately; never in a Dockerfile. */
  get allowInsecureDev() {
    return ['1', 'true', 'yes'].includes(String(process.env.ALLOW_INSECURE_DEV || '').toLowerCase());
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
    ['WEBHOOK_SECRET', bootConfig.webhookSecret, 'the webhook would be UNAUTHENTICATED'],
    ['ADMIN_PASSWORD', bootConfig.adminPassword, 'the settings UI would be unprotected'],
    ['SECRET_KEY', bootConfig.secretKey, 'API keys could not be stored encrypted at rest'],
  ];
  for (const [name, value, why] of need) {
    if (value) continue;
    if (bootConfig.isProduction) fatal.push(`${name} is required in production — ${why}.`);
    else if (bootConfig.allowInsecureDev) warnings.push(`${name} is not set — ${why} (ALLOW_INSECURE_DEV is on).`);
    else fatal.push(`${name} is not set — ${why}. Set it, or set ALLOW_INSECURE_DEV=1 to run open locally.`);
  }

  // A weak ADMIN_PASSWORD is the whole security boundary: it guards the API keys, the send
  // button, and every candidate's personal email. Brute force is online and unattended, so
  // length is the only defence that scales.
  if (bootConfig.adminPassword && bootConfig.adminPassword.length < 12) {
    const msg = 'ADMIN_PASSWORD is shorter than 12 characters — it guards the API keys and live sending.';
    if (bootConfig.isProduction) fatal.push(msg);
    else warnings.push(msg);
  }

  // SECRET_KEY is stretched with scrypt, but a short passphrase still falls to an offline
  // attack against data/settings.json, which is a self-verifying oracle (GCM tag).
  if (bootConfig.secretKey && bootConfig.secretKey.length < 32) {
    warnings.push('SECRET_KEY is shorter than 32 characters — generate one with `openssl rand -hex 32`.');
  }

  return { fatal, warnings };
}
