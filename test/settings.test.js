import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Configure a clean, isolated data dir + encryption key BEFORE importing (config reads env at load).
process.env.SECRET_KEY = 'unit-test-secret-key';
process.env.DATA_DIR = join(os.tmpdir(), 'cf-settings-' + Math.random().toString(36).slice(2));
delete process.env.APOLLO_API_KEY;

const SETTINGS_PATH = join(process.env.DATA_DIR, 'settings.json');
const settings = await import('../src/settings.js');

test('encrypt/decrypt round-trips and does not leak plaintext', () => {
  const blob = settings.encryptSecret('super-secret-value');
  assert.notEqual(blob, 'super-secret-value');
  assert.ok(!blob.includes('super-secret'));
  assert.equal(settings.decryptSecret(blob), 'super-secret-value');
});

test('updateSettings persists an encrypted key that reads back decrypted', () => {
  settings.updateSettings({ apolloApiKey: 'apollo-xyz-1234' });
  assert.equal(settings.getSettings().apollo.apiKey, 'apollo-xyz-1234');
  const masked = settings.getMaskedSettings();
  assert.equal(masked.keys.apollo.set, true);
  assert.equal(masked.keys.apollo.last4, '1234');
});

test('empty-string secret leaves the existing key untouched; null clears it', () => {
  settings.updateSettings({ apolloApiKey: '' }); // no-op
  assert.equal(settings.getSettings().apollo.apiKey, 'apollo-xyz-1234');
  settings.updateSettings({ apolloApiKey: null }); // clear
  assert.equal(settings.getSettings().apollo.apiKey, '');
});

test('non-secret values persist and coerce types', () => {
  settings.updateSettings({ scoreThreshold: 75, dryRun: true, weightAi: 0.5 });
  const s = settings.getSettings();
  assert.equal(s.scoring.threshold, 75);
  assert.equal(s.dryRun, true);
  assert.equal(s.scoring.weights.aiFit, 0.5);
});

test('env var is used as a fallback when nothing is persisted', () => {
  process.env.SALESQL_API_KEY = 'env-salesql-key';
  settings._resetCache();
  assert.equal(settings.getSettings().salesql.apiKey, 'env-salesql-key');
});

test('dry-run override wins without persisting', () => {
  settings.setDryRunOverride(false);
  assert.equal(settings.getSettings().dryRun, false);
  settings.setDryRunOverride(undefined);
});

// Secrets are now keyed with scrypt rather than a bare sha256 of SECRET_KEY. Blobs written by
// the old code must stay readable — otherwise deploying this upgrade silently locks the
// operator out of the API keys they already saved, and the app just stops working.
test('secrets encrypted before the KDF migration are still readable', () => {
  const legacyKey = crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  const enc = Buffer.concat([cipher.update('legacy-apollo-key', 'utf8'), cipher.final()]);
  const legacyBlob = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');

  assert.equal(settings.decryptSecret(legacyBlob), 'legacy-apollo-key');
});

test('a corrupt blob decrypts to empty rather than throwing', () => {
  assert.equal(settings.decryptSecret('not-base64-at-all!!'), '');
  assert.equal(settings.decryptSecret(''), '');
});

// THE restart test. The scrypt salt lives on disk; if any write drops it, a new salt is minted on
// the next boot, derives a different key, and every saved API key decrypts to '' — silently, and
// with the ciphertext unrecoverable. In-process reads hide this completely, because the salt is
// still cached in memory. Assert against the FILE, and against a cache-cleared re-read.
test('the KDF salt survives a write, so keys still decrypt after a restart', () => {
  settings.updateSettings({ apolloApiKey: 'apollo-restart-key-4321', scoreThreshold: 70 });

  // The salt must be ON DISK, not merely in the module's cache.
  const onDisk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.ok(onDisk.kdfSalt, 'kdfSalt was dropped by updateSettings — every saved key dies on restart');

  // Simulate the restart: clear every cache, exactly as a fresh process starts.
  settings._resetCache();
  assert.equal(settings.getSettings().apollo.apiKey, 'apollo-restart-key-4321',
    'the key must still decrypt once the in-memory salt cache is gone');
  assert.equal(settings.getSettings().scoring.threshold, 70, 'ordinary values survive too');

  // A later write must reuse the same salt, not mint a fresh one.
  settings.updateSettings({ scoreThreshold: 72 });
  assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).kdfSalt, onDisk.kdfSalt, 'the salt must be stable');
  settings._resetCache();
  assert.equal(settings.getSettings().apollo.apiKey, 'apollo-restart-key-4321', 'and the key still reads back');
});

// These bounds are spend limits: discoverLimit was unclamped behind a bare number input, so
// typing 10000 authorized a four-figure Apollo bill on the next preview.
test('updateSettings refuses out-of-range numbers with an actionable message', () => {
  assert.throws(() => settings.updateSettings({ discoverLimit: 10000 }), /between 1 and 500/);
  assert.throws(() => settings.updateSettings({ scoreThreshold: 500 }), /between 0 and 100/);
  assert.throws(() => settings.updateSettings({ weightAi: 5 }), /between 0 and 1/);
  assert.throws(() => settings.updateSettings({ maxCandidates: 0 }), /between 1 and 200/);
  // Enriching more people than we discovered is incoherent and wastes paid lookups.
  assert.throws(() => settings.updateSettings({ discoverLimit: 10, maxCandidates: 50 }), /cannot exceed/);
});

test('updateSettings does not mutate the caller-supplied patch', () => {
  // The patch is req.body on the admin route; stripping keys out of it rewrites the caller's object.
  const patch = { apolloApiKey: 'abc123', scoreThreshold: 65 };
  settings.updateSettings(patch);
  assert.equal(patch.apolloApiKey, 'abc123', 'the caller\'s object must come back untouched');
});
