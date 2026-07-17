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

/**
 * Write the list to disk. Deliberately throws on failure.
 *
 * This used to swallow every error, so a full or read-only disk returned "added" to the
 * operator, worked in memory, and then lost the entry on restart — quietly re-enabling email
 * to someone who asked never to be contacted. This is the one list whose write failure must be
 * loud. Callers surface the error; the entry is rolled back so memory matches disk.
 */
function persist() {
  mkdirSync(bootConfig.dataDir, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, FILE); // atomic replace — a crash mid-write can't tear the file
}

/** True if this email — or its whole domain — is on the do-not-contact list. */
export function isSuppressed(email) {
  const e = norm(email);
  if (!e) return true; // no email = can't safely contact
  return store.emails.includes(e) || (domainOf(e) && store.domains.includes(domainOf(e)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Classify an entry as an email or a whole domain.
 *
 * The leading "@" must be stripped BEFORE the bucket decision. It used to be stripped only in
 * the domain branch, so "@competitor.com" — the most natural way to write "block this domain" —
 * contained an "@", landed in `emails`, and matched nobody. The operator saw it listed and
 * believed they were protected, and `unsuppress` (which did strip "@") couldn't even remove it.
 *
 * @returns {{bucket:'emails'|'domains', value:string}}
 * @throws if the value is neither a valid email nor a valid domain.
 */
export function classify(value) {
  const v = norm(value).replace(/^@/, '');
  if (!v) throw new Error('Enter an email address or a domain.');
  if (v.includes('@')) {
    if (!EMAIL_RE.test(v)) throw new Error(`"${value}" is not a valid email address.`);
    return { bucket: 'emails', value: v };
  }
  // A bare word like a typo'd "john" would otherwise silently blocklist a "john" domain.
  if (!DOMAIN_RE.test(v)) throw new Error(`"${value}" is not a valid email address or domain.`);
  return { bucket: 'domains', value: v };
}

/** Add an entry. "@acme.com" and "acme.com" both mean the whole domain. */
export function suppress(value) {
  const { bucket, value: clean } = classify(value);
  if (store[bucket].includes(clean)) return listSuppression();
  store[bucket].push(clean);
  try {
    persist();
  } catch (err) {
    store[bucket] = store[bucket].filter((x) => x !== clean); // keep memory consistent with disk
    throw new Error(`Could not save the do-not-contact list: ${err.message}`);
  }
  return listSuppression();
}

/** Remove an entry (email or domain). */
export function unsuppress(value) {
  const v = norm(value).replace(/^@/, '');
  const before = { emails: [...store.emails], domains: [...store.domains] };
  store.emails = store.emails.filter((x) => x !== v);
  store.domains = store.domains.filter((x) => x !== v);
  try {
    persist();
  } catch (err) {
    store = before;
    throw new Error(`Could not save the do-not-contact list: ${err.message}`);
  }
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
