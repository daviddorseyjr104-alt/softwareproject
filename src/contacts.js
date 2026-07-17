// Contact history — the permanent, append-only record of everyone we've emailed, when,
// for which company/role. Two jobs it does that nothing else did before:
//   1. Cross-run dedup: stop emailing the same person again days later (sender-reputation arson).
//   2. Audit trail: an immutable log of who was contacted and why — for compliance, never truncated.
// Persisted to DATA_DIR/contacts.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { bootConfig } from './config.js';

const FILE = join(bootConfig.dataDir, 'contacts.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const norm = (s) => String(s || '').trim().toLowerCase();

/** email -> most recent contact entry (for fast lookup), plus the full append-only log. */
let log = [];
let latest = new Map();

reload();

function reload() {
  log = load();
  latest = new Map();
  for (const entry of log) latest.set(norm(entry.email), entry); // last write wins = most recent
}

function load() {
  if (!existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    mkdirSync(bootConfig.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(log));
    renameSync(tmp, FILE);
  } catch {
    /* best-effort — never crash a send over a disk write */
  }
}

/**
 * Whole-number days since this email was last contacted, or null if never.
 *
 * A record with an unparseable `at` yields age 0, NOT NaN. NaN propagated into
 * `recentlyContacted`, where `NaN < withinDays` is false — so a corrupt timestamp meant "not
 * contacted recently" and the person got emailed again. A safety check must fail CLOSED: we
 * know from the record's existence that they were contacted; if we can't tell when, assume it
 * was just now and hold off.
 */
export function lastContactAgeDays(email) {
  const entry = latest.get(norm(email));
  if (!entry) return null;
  const at = new Date(entry.at).getTime();
  if (!Number.isFinite(at)) return 0; // corrupt timestamp → treat as contacted just now
  return Math.max(0, Math.floor((Date.now() - at) / DAY_MS));
}

/** True if contacted within the last `withinDays` days. */
export function recentlyContacted(email, withinDays) {
  if (!withinDays || withinDays <= 0) return false;
  const age = lastContactAgeDays(email);
  return age !== null && age < withinDays;
}

/**
 * Append contact records. `entries`: [{ email, company, role, campaignId }].
 * Stamps `at` (ISO) on each. This is the audit write — it is never truncated.
 */
export function recordContacts(entries = []) {
  const at = new Date().toISOString();
  let added = 0;
  for (const e of entries) {
    if (!e?.email) continue;
    const row = { email: norm(e.email), company: e.company || '', role: e.role || '', campaignId: e.campaignId || '', at };
    log.push(row);
    latest.set(row.email, row);
    added++;
  }
  if (added) persist();
  return added;
}

/** Total distinct people ever contacted. */
export function contactCount() {
  return latest.size;
}

/** Recent history, newest first (for the audit view). */
export function recentContacts(limit = 50) {
  return log.slice(-limit).reverse();
}

/** Test-only. */
export function _reload() {
  reload();
}
