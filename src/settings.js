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
// AES-256-GCM with a scrypt-stretched key. Ciphertext framing: iv(12) | tag(16) | payload.
//
// The key is derived with scrypt rather than a bare SHA-256: settings.json is an offline
// oracle (the GCM tag verifies each guess), so an unsalted single hash of a hand-typed
// SECRET_KEY is GPU-brute-forceable at billions of guesses/sec. scrypt makes each guess cost
// ~64MB of memory. The salt is stored next to the ciphertext — it defeats rainbow tables, and
// is not itself a secret.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LEGACY_PREFIX = 'v1:'; // pre-KDF blobs, keyed by bare sha256(SECRET_KEY)

let saltCache = null;

/** Random per-store salt, persisted beside the secrets so the KDF is deterministic across boots. */
function storeSalt() {
  if (saltCache) return saltCache;
  const store = readStore();
  if (store.kdfSalt) {
    saltCache = Buffer.from(store.kdfSalt, 'base64');
  } else {
    saltCache = crypto.randomBytes(16);
    store.kdfSalt = saltCache.toString('base64');
    writeStore(store);
  }
  return saltCache;
}

/** Derived 32-byte key. Cached — scrypt at these params takes ~100ms and runs per request. */
let derivedKeyCache = null;
function keyBytes() {
  if (!bootConfig.secretKey) return null;
  if (!derivedKeyCache) {
    derivedKeyCache = crypto.scryptSync(bootConfig.secretKey, storeSalt(), 32, SCRYPT_PARAMS);
  }
  return derivedKeyCache;
}

/** The old bare-sha256 key, retained only to read secrets written before the KDF landed. */
function legacyKeyBytes() {
  if (!bootConfig.secretKey) return null;
  return crypto.createHash('sha256').update(bootConfig.secretKey).digest();
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

function open(blob, key) {
  const raw = Buffer.from(blob, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function decryptSecret(blob) {
  if (!blob || !bootConfig.secretKey) return '';
  // Blobs written before the scrypt migration are tagged and opened with the old key, so an
  // upgrade doesn't silently lock the operator out of their own saved API keys.
  if (blob.startsWith(LEGACY_PREFIX)) {
    try {
      return open(blob.slice(LEGACY_PREFIX.length), legacyKeyBytes());
    } catch {
      return '';
    }
  }
  try {
    return open(blob, keyBytes());
  } catch {
    // Untagged blob that won't open under the new key: it predates the migration marker.
    try {
      return open(blob, legacyKeyBytes());
    } catch {
      return ''; // wrong SECRET_KEY or corrupt blob → behave as "no key"
    }
  }
}

// ---- persistence ---------------------------------------------------------
function readStore() {
  if (!existsSync(SETTINGS_FILE)) return { version: 1, secrets: {}, values: {} };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    // kdfSalt must survive a read-modify-write cycle: dropping it would derive a fresh salt on
    // the next boot and render every persisted API key permanently undecryptable.
    const store = { version: 1, secrets: parsed.secrets || {}, values: parsed.values || {} };
    if (parsed.kdfSalt) store.kdfSalt = parsed.kdfSalt;
    return store;
  } catch {
    return { version: 1, secrets: {}, values: {} };
  }
}

function writeStore(store) {
  // Never let a write drop the KDF salt.
  //
  // Every caller here is a read-modify-write, and `updateSettings` reads the store BEFORE
  // encryptSecret lazily mints and persists the salt — so its stale copy wrote straight back
  // over it. The salt then lived only in `saltCache`, so everything worked until the next
  // restart, at which point a fresh salt derived a different key and every saved API key
  // decrypted to '' — silently, and unrecoverably. Enforcing it at the sink means no future
  // caller has to remember.
  if (!store.kdfSalt && saltCache) store.kdfSalt = saltCache.toString('base64');
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
/**
 * Bounds for operator-editable numbers.
 *
 * These are spend and safety limits, not cosmetics. `discoverLimit` was an unclamped
 * `int(v, 100)` behind a bare number input: typing 10000 and hitting Save authorized a
 * four-figure Apollo bill on the next Preview, with a cheerful "Settings saved." toast and no
 * confirmation. A threshold of 500 silently made every future run return no_matches forever.
 * Validate at the store, not the input — the API is reachable without the UI.
 */
const NUMERIC_BOUNDS = {
  maxCandidates: { min: 1, max: 200, label: 'Finalists to enrich' },
  discoverLimit: { min: 1, max: 500, label: 'Candidates to discover per role' },
  scoreThreshold: { min: 0, max: 100, label: 'Score threshold' },
  dedupeWindowDays: { min: 0, max: 3650, label: 'Dedupe window (days)' },
  scheduleHours: { min: 0, max: 8760, label: 'Schedule (hours)' },
  weightAi: { min: 0, max: 1, label: 'AI weight' },
  weightSkills: { min: 0, max: 1, label: 'Skills weight' },
  weightSeniority: { min: 0, max: 1, label: 'Seniority weight' },
  weightPedigree: { min: 0, max: 1, label: 'Pedigree weight' },
};

function validatePatch(patch) {
  for (const [key, bound] of Object.entries(NUMERIC_BOUNDS)) {
    if (!(key in patch) || patch[key] === undefined || patch[key] === '') continue;
    const n = Number(patch[key]);
    if (!Number.isFinite(n)) throw new Error(`${bound.label} must be a number.`);
    if (n < bound.min || n > bound.max) {
      throw new Error(`${bound.label} must be between ${bound.min} and ${bound.max} (got ${n}).`);
    }
  }
  // discoverLimit is the wide net we pre-rank down from; enriching more than we discovered is
  // incoherent and would silently waste paid SalesQL lookups.
  const discover = patch.discoverLimit ?? undefined;
  const finalists = patch.maxCandidates ?? undefined;
  if (discover !== undefined && finalists !== undefined && Number(finalists) > Number(discover)) {
    throw new Error(`Finalists to enrich (${finalists}) cannot exceed candidates discovered per role (${discover}).`);
  }
  return patch;
}

export function updateSettings(patchInput = {}) {
  validatePatch(patchInput);
  // Work on a copy: the secret-stripping below used to `delete` keys from the caller's object,
  // which is req.body on the admin route — a function that quietly rewrites its argument.
  const patch = { ...patchInput };
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

  // Only persist keys the app actually reads. Without an allowlist, any field a client posts is
  // written to settings.json verbatim and kept forever.
  const known = new Set([...Object.keys(NUMERIC_BOUNDS), 'seniorities', 'personalOnly', 'instantlyTimezone',
    'instantlySendingFrom', 'instantlySendingTo', 'instantlyTemplateCampaignId', 'aiEffort', 'dryRun',
    'testCompanyNames', 'enrichGithub']);
  const accepted = Object.fromEntries(Object.entries(stripUndefined(patch)).filter(([k]) => known.has(k)));

  store.values = { ...store.values, ...accepted };
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

/**
 * Test-only: drop the in-memory caches so a fresh env/store is re-read.
 * The salt/key caches must be cleared too — leaving them set makes an in-process test look like
 * it works while a real restart (which has no caches) fails. That is exactly how the salt-clobber
 * bug hid behind a green suite.
 */
export function _resetCache() {
  cache = null;
  dryRunOverride = undefined;
  saltCache = null;
  derivedKeyCache = null;
}
