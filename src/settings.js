// Runtime settings service — the durable, editable configuration the admin UI writes to.
//
// Effective settings = persisted store (DATA_DIR/settings.json) first, then env-var fallback.
// Secret fields (the four API keys) are encrypted at rest with AES-256-GCM using SECRET_KEY.
// Providers/scoring call getSettings() at request time, so a key saved in the UI takes effect
// on the next run with no restart. Shape matches what consumers already expect.
import 'dotenv/config';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { bootConfig } from './config.js';

const SETTINGS_FILE = join(bootConfig.dataDir, 'settings.json');
const SECRET_FIELDS = ['apollo', 'salesql', 'instantly', 'anthropic', 'github'];

// ---- helpers -------------------------------------------------------------
const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
const list = (v) =>
  Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean)
    : String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---- encryption ----------------------------------------------------------
function keyBytes() {
  if (!bootConfig.secretKey) return null;
  return crypto.createHash('sha256').update(bootConfig.secretKey).digest(); // 32 bytes
}

export function encryptSecret(plain) {
  const key = keyBytes();
  if (!key) throw new Error('Cannot encrypt: SECRET_KEY is not set.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(blob) {
  const key = keyBytes();
  if (!key || !blob) return '';
  try {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ''; // wrong SECRET_KEY or corrupt blob → behave as "no key"
  }
}

// ---- persistence ---------------------------------------------------------
function readStore() {
  if (!existsSync(SETTINGS_FILE)) return { version: 1, secrets: {}, values: {} };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return { version: 1, secrets: parsed.secrets || {}, values: parsed.values || {} };
  } catch {
    return { version: 1, secrets: {}, values: {} };
  }
}

function writeStore(store) {
  mkdirSync(bootConfig.dataDir, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, SETTINGS_FILE); // atomic replace
}

// ---- effective settings --------------------------------------------------
let cache = null;
let dryRunOverride = undefined; // set by CLIs (match/dry-run/doctor) without persisting

function build() {
  const store = readStore();
  const v = store.values;

  // A secret is the decrypted persisted value if present, else the env fallback.
  const secret = (field, envName) => {
    const persisted = store.secrets[field] ? decryptSecret(store.secrets[field]) : '';
    return persisted || process.env[envName] || '';
  };

  const dryRun = dryRunOverride !== undefined ? dryRunOverride : bool(v.dryRun ?? process.env.DRY_RUN, false);

  return {
    apollo: {
      apiKey: secret('apollo', 'APOLLO_API_KEY'),
      // How many FINALISTS to enrich (the paid step) — the top N after deterministic pre-ranking.
      maxCandidates: int(v.maxCandidates ?? process.env.MAX_CANDIDATES, 25),
      // How many to DISCOVER per role (the cheap, wide net we pre-rank down from). >= maxCandidates.
      discoverLimit: int(v.discoverLimit ?? process.env.DISCOVER_LIMIT, 100),
      seniorities: list(v.seniorities ?? process.env.APOLLO_SENIORITIES),
    },
    salesql: {
      apiKey: secret('salesql', 'SALESQL_API_KEY'),
      personalOnly: bool(v.personalOnly ?? process.env.PERSONAL_EMAILS_ONLY, true),
    },
    instantly: {
      apiKey: secret('instantly', 'INSTANTLY_API_KEY'),
      timezone: v.instantlyTimezone ?? process.env.INSTANTLY_TIMEZONE ?? 'America/New_York',
      sendingFrom: v.instantlySendingFrom ?? process.env.INSTANTLY_SENDING_FROM ?? '09:00',
      sendingTo: v.instantlySendingTo ?? process.env.INSTANTLY_SENDING_TO ?? '17:00',
      templateCampaignId: v.instantlyTemplateCampaignId ?? process.env.INSTANTLY_TEMPLATE_CAMPAIGN_ID ?? '',
    },
    ai: {
      apiKey: secret('anthropic', 'ANTHROPIC_API_KEY'),
      effort: v.aiEffort ?? process.env.AI_EFFORT ?? 'low',
    },
    github: {
      apiKey: secret('github', 'GITHUB_TOKEN'), // optional — lifts the rate limit
      enrich: bool(v.enrichGithub ?? process.env.ENRICH_GITHUB, true), // pull real GitHub signal
    },
    scoring: {
      threshold: int(v.scoreThreshold ?? process.env.SCORE_THRESHOLD, 60),
      weights: {
        aiFit: num(v.weightAi ?? process.env.WEIGHT_AI, 0.4),
        skills: num(v.weightSkills ?? process.env.WEIGHT_SKILLS, 0.25),
        seniority: num(v.weightSeniority ?? process.env.WEIGHT_SENIORITY, 0.2),
        pedigree: num(v.weightPedigree ?? process.env.WEIGHT_PEDIGREE, 0.15),
      },
    },
    dryRun,
    testCompanyNames: list(v.testCompanyNames ?? process.env.TEST_COMPANY_NAMES).map((s) => s.toLowerCase()),
    // Cross-run dedup: don't re-email anyone contacted within this many days (0 = off).
    dedupeWindowDays: int(v.dedupeWindowDays ?? process.env.DEDUPE_WINDOW_DAYS, 0),
    // Automated sourcing: re-run the pool preview every N hours (0 = off). Never auto-sends.
    scheduleHours: int(v.scheduleHours ?? process.env.SCHEDULE_HOURS, 0),
  };
}

/** Effective, merged settings (cached until updateSettings/override changes them). */
export function getSettings() {
  if (!cache) cache = build();
  return cache;
}

/** Force dry-run on/off for a process (used by CLIs) without persisting. */
export function setDryRunOverride(value) {
  dryRunOverride = value;
  cache = null;
}

/**
 * Persist a patch. Secret keys are encrypted; empty-string secrets are ignored (leave existing);
 * a secret explicitly set to null clears it. Non-secret values are stored as-is.
 * @param {object} patch  e.g. { apolloApiKey, salesqlApiKey, instantlyApiKey, anthropicApiKey,
 *                               maxCandidates, weightAi, scoreThreshold, dryRun, ... }
 */
export function updateSettings(patch = {}) {
  const store = readStore();
  const secretMap = {
    apolloApiKey: 'apollo',
    salesqlApiKey: 'salesql',
    instantlyApiKey: 'instantly',
    anthropicApiKey: 'anthropic',
    githubApiKey: 'github',
  };

  for (const [patchKey, field] of Object.entries(secretMap)) {
    if (!(patchKey in patch)) continue;
    const val = patch[patchKey];
    if (val === null) delete store.secrets[field]; // explicit clear
    else if (typeof val === 'string' && val.trim() !== '') store.secrets[field] = encryptSecret(val.trim());
    // empty string / undefined → leave the existing secret untouched
    delete patch[patchKey];
  }

  store.values = { ...store.values, ...stripUndefined(patch) };
  writeStore(store);
  cache = null;
  return getMaskedSettings();
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Non-secret values plus a safe {set, last4} descriptor for each API key — for the admin UI. */
export function getMaskedSettings() {
  const s = getSettings();
  const mask = (k) => ({ set: Boolean(k), last4: k ? k.slice(-4) : '' });
  return {
    keys: {
      apollo: mask(s.apollo.apiKey),
      salesql: mask(s.salesql.apiKey),
      instantly: mask(s.instantly.apiKey),
      anthropic: mask(s.ai.apiKey),
      github: mask(s.github.apiKey),
    },
    values: {
      maxCandidates: s.apollo.maxCandidates,
      discoverLimit: s.apollo.discoverLimit,
      scheduleHours: s.scheduleHours,
      seniorities: s.apollo.seniorities,
      personalOnly: s.salesql.personalOnly,
      instantlyTimezone: s.instantly.timezone,
      instantlySendingFrom: s.instantly.sendingFrom,
      instantlySendingTo: s.instantly.sendingTo,
      instantlyTemplateCampaignId: s.instantly.templateCampaignId,
      aiEffort: s.ai.effort,
      scoreThreshold: s.scoring.threshold,
      weightAi: s.scoring.weights.aiFit,
      weightSkills: s.scoring.weights.skills,
      weightSeniority: s.scoring.weights.seniority,
      weightPedigree: s.scoring.weights.pedigree,
      dryRun: s.dryRun,
      testCompanyNames: s.testCompanyNames,
      dedupeWindowDays: s.dedupeWindowDays,
      enrichGithub: s.github.enrich,
    },
    encryptionEnabled: Boolean(bootConfig.secretKey),
  };
}

/** Test-only: drop the in-memory cache so a fresh env/store is re-read. */
export function _resetCache() {
  cache = null;
  dryRunOverride = undefined;
}
