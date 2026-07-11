import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

// Configure a clean, isolated data dir + encryption key BEFORE importing (config reads env at load).
process.env.SECRET_KEY = 'unit-test-secret-key';
process.env.DATA_DIR = join(os.tmpdir(), 'cf-settings-' + Math.random().toString(36).slice(2));
delete process.env.APOLLO_API_KEY;

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
