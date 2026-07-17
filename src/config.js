// BOOT-ONLY configuration: values needed to start the process and secure it.
// Everything the client can change at runtime (API keys, scoring weights, the pool, dry-run)
// lives in src/settings.js instead — a durable, editable store the admin UI writes to.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
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
 * Is DATA_DIR backed by a real volume, or by throwaway container storage?
 *
 * This matters far more than it looks. DATA_DIR holds suppression.json — the do-not-contact
 * list — plus the contact audit trail, the company pool, and the encrypted API keys. On
 * ephemeral storage every deploy silently resets all of it, so someone who unsubscribed is
 * eligible again the next time you ship. The app keeps its promise for exactly as long as you
 * don't deploy, and nothing anywhere says so.
 *
 * It's easy to get wrong: the persistence lives in the HOST's config (a Render `disk:`, a
 * Railway volume), not in the repo, so moving hosts quietly drops it. Detect it instead of
 * trusting a README.
 *
 * @returns {{known:boolean, persisted?:boolean}} `known:false` when we can't tell (not Linux).
 */
export function dataDirPersistence() {
  let mounts;
  try {
    mounts = readFileSync('/proc/mounts', 'utf8');
  } catch {
    return { known: false }; // not a Linux container (dev box, CI) — don't guess
  }
  return { known: true, persisted: isOnMountedVolume(bootConfig.dataDir, mounts) };
}

/**
 * Pure half of the check, so it can be tested off-Linux with real /proc/mounts fixtures.
 * @param {string} dir absolute path
 * @param {string} mountsText contents of /proc/mounts
 */
export function isOnMountedVolume(dir, mountsText) {
  const targets = String(mountsText || '').split('\n')
    .map((line) => line.split(' ')[1])
    .filter(Boolean)
    .map((t) => t.replace(/\\040/g, ' ')); // /proc/mounts octal-escapes spaces

  // A volume shows up as a mount AT the data dir (Render disks, Railway volumes, k8s PVCs) or at
  // a proper ancestor. "/" doesn't count — that's the container's own writable layer, which is
  // exactly the throwaway case we're looking for.
  return targets.some((t) =>
    t === dir || (t !== '/' && dir.startsWith(t.endsWith('/') ? t : `${t}/`)));
}

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
  // length is the only defence that scales — and POST /admin/login is rate limited to make a
  // short password expensive to guess rather than free.
  //
  // This WARNS. It must never be fatal: password length is a pre-existing condition on any
  // already-running deployment, and refusing to boot over it turns a routine upgrade into an
  // outage — taking the service down to protest a risk it was already carrying, and taking the
  // admin UI (the place you'd fix it) down with it. Loud beats dead.
  if (bootConfig.adminPassword && bootConfig.adminPassword.length < 12) {
    warnings.push(
      `ADMIN_PASSWORD is only ${bootConfig.adminPassword.length} characters — it guards your API keys, `
      + 'live sending, and every candidate\'s personal email. Use 16+ random characters.',
    );
  }

  // SECRET_KEY is stretched with scrypt, but a short passphrase still falls to an offline
  // attack against data/settings.json, which is a self-verifying oracle (GCM tag).
  if (bootConfig.secretKey && bootConfig.secretKey.length < 32) {
    warnings.push('SECRET_KEY is shorter than 32 characters — generate one with `openssl rand -hex 32`.');
  }

  // Ephemeral DATA_DIR: the do-not-contact list and the audit trail reset on every deploy.
  // Warn, don't block — this is a host misconfiguration the operator must fix on the host, and
  // refusing to boot would take down the console they'd read the explanation in. The admin UI
  // shows a standing banner for the same reason: a single startup line is easy to miss.
  const disk = dataDirPersistence();
  if (bootConfig.isProduction && disk.known && !disk.persisted) {
    warnings.push(
      `DATA_DIR (${bootConfig.dataDir}) is NOT on a mounted volume — it is throwaway container `
      + 'storage. Your do-not-contact list, contact audit trail, company pool and saved API keys '
      + 'will be ERASED on every deploy and restart, so people who unsubscribed can be emailed '
      + 'again. Attach a persistent volume at this path (see docs/DEPLOY.md).',
    );
  }

  return { fatal, warnings };
}
