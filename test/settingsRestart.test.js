// Isolated ON PURPOSE — this must be the first crypto operation against a FRESH data dir.
//
// The salt-clobber bug only fires on the very first write to a new (or pre-KDF) store:
// updateSettings reads the store before encryptSecret lazily mints and persists the salt, then
// writes its stale copy back over it. Any earlier call that touches encryption puts the salt on
// disk first and hides the bug entirely — which is exactly what happens in settings.test.js,
// where an encrypt/decrypt round-trip runs before any updateSettings.
//
// Each test file is its own process under `node --test`, so this file gets a clean module state.
// Without that isolation this test passes whether or not the bug is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.SECRET_KEY = 'restart-test-secret-key';
process.env.DATA_DIR = join(os.tmpdir(), 'cf-restart-' + Math.random().toString(36).slice(2));
delete process.env.APOLLO_API_KEY;

const SETTINGS_PATH = join(process.env.DATA_DIR, 'settings.json');
const settings = await import('../src/settings.js');

test('saving a key on a FRESH store persists the salt, so the key survives a restart', () => {
  // First contact with encryption: nothing has minted a salt yet.
  settings.updateSettings({ apolloApiKey: 'apollo-first-write-5678' });

  const onDisk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.ok(onDisk.secrets.apollo, 'sanity: the key was encrypted and stored');
  assert.ok(
    onDisk.kdfSalt,
    'kdfSalt is missing from settings.json — the next restart derives a different key and every '
    + 'saved API key silently decrypts to empty, unrecoverably',
  );

  // A restart has no in-memory caches. Clearing them is the whole point of this assertion:
  // an in-process read passes even when the salt was dropped, because saltCache still holds it.
  settings._resetCache();
  assert.equal(
    settings.getSettings().apollo.apiKey, 'apollo-first-write-5678',
    'the saved key must still decrypt with only what is on disk',
  );
});
