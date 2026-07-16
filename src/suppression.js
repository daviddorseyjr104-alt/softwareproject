// Do-not-contact list. The hard stop before any outreach: emails or whole domains
// that must never receive a message (unsubscribes, complaints, competitors, personal asks).
// Persisted to DATA_DIR/suppression.json so it survives restarts and is shared across every run.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { bootConfig } from './config.js';

const FILE = join(bootConfig.dataDir, 'suppression.json');

const norm = (s) => String(s || '').trim().toLowerCase();
const domainOf = (email) => norm(email).split('@')[1] || '';

let store = load();

function load() {
  const empty = { emails: [], domains: [] };
  if (!existsSync(FILE)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      emails: (parsed.emails || []).map(norm).filter(Boolean),
      domains: (parsed.domains || []).map(norm).filter(Boolean),
    };
  } catch {
    return empty;
  }
}

function persist() {
  try {
    mkdirSync(bootConfig.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch {
    /* best-effort */
  }
}

/** True if this email — or its whole domain — is on the do-not-contact list. */
export function isSuppressed(email) {
  const e = norm(email);
  if (!e) return true; // no email = can't safely contact
  return store.emails.includes(e) || (domainOf(e) && store.domains.includes(domainOf(e)));
}

/** Add an entry. A value containing "@" is treated as an email; otherwise a domain. */
export function suppress(value) {
  const v = norm(value);
  if (!v) return listSuppression();
  const bucket = v.includes('@') ? 'emails' : 'domains';
  const clean = bucket === 'domains' ? v.replace(/^@/, '') : v;
  if (!store[bucket].includes(clean)) {
    store[bucket].push(clean);
    persist();
  }
  return listSuppression();
}

/** Remove an entry (email or domain). */
export function unsuppress(value) {
  const v = norm(value).replace(/^@/, '');
  store.emails = store.emails.filter((x) => x !== v);
  store.domains = store.domains.filter((x) => x !== v);
  persist();
  return listSuppression();
}

/** Bulk add (used when syncing unsubscribes). */
export function suppressMany(values = []) {
  for (const v of values) suppress(v);
  return listSuppression();
}

export function listSuppression() {
  return { emails: [...store.emails], domains: [...store.domains] };
}

/** Test-only: reset in-memory state to what's on disk. */
export function _reload() {
  store = load();
}
