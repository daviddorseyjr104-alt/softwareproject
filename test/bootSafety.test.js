// Boot safety decides whether the process starts AT ALL, so every fatal here is an outage if it
// misfires. This suite exists because one did: ADMIN_PASSWORD length was made fatal in
// production, and the next deploy of a running service exited 1 before it could listen — the
// health check failed for five minutes and the deploy rolled back. The password was too short
// before the upgrade too; refusing to boot didn't protect anything, it just took the app down
// (including the admin UI you'd fix it from).
//
// The rule this file enforces: fatal ONLY for a missing secret, which is a genuinely open door.
// Everything else — weak-but-present credentials — warns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootConfig, bootSafety } from '../src/config.js';

/** Run bootSafety against a temporary bootConfig state. */
function withConfig(patch, fn) {
  const saved = { ...patch };
  for (const k of Object.keys(patch)) saved[k] = bootConfig[k];
  Object.assign(bootConfig, patch);
  try { return fn(); } finally { Object.assign(bootConfig, saved); }
}

const PROD = { nodeEnv: 'production', webhookSecret: 'w'.repeat(20), secretKey: 's'.repeat(40), adminPassword: 'p'.repeat(20) };

test('a healthy production config boots with no fatals', () => {
  const { fatal } = withConfig(PROD, bootSafety);
  assert.deepEqual(fatal, [], `nothing should block boot, got: ${fatal}`);
});

test('a SHORT admin password warns but never blocks boot', () => {
  // The exact shape of the outage: a running deployment whose password predates the check.
  const { fatal, warnings } = withConfig({ ...PROD, adminPassword: 'kaizen123' }, bootSafety);
  assert.deepEqual(fatal, [], 'a weak-but-present password must NEVER stop the app from starting');
  assert.ok(warnings.some((w) => /ADMIN_PASSWORD is only 9 characters/.test(w)), 'but it must be said loudly');
});

test('a short SECRET_KEY warns but never blocks boot', () => {
  const { fatal, warnings } = withConfig({ ...PROD, secretKey: 'short' }, bootSafety);
  assert.deepEqual(fatal, []);
  assert.ok(warnings.some((w) => /SECRET_KEY is shorter/.test(w)));
});

test('a MISSING secret is fatal in production — that is an open door, not a weak lock', () => {
  for (const [key, name] of [['webhookSecret', 'WEBHOOK_SECRET'], ['adminPassword', 'ADMIN_PASSWORD'], ['secretKey', 'SECRET_KEY']]) {
    const { fatal } = withConfig({ ...PROD, [key]: '' }, bootSafety);
    assert.ok(fatal.some((f) => f.startsWith(name)), `missing ${name} must be fatal in production`);
  }
});

test('an unrecognized NODE_ENV is treated as production, not as development', () => {
  // A host that forgets NODE_ENV must get the strict checks, not a silently open console.
  const { fatal } = withConfig({ ...PROD, nodeEnv: 'staging', adminPassword: '' }, bootSafety);
  assert.ok(fatal.length > 0, '"staging" must fail closed');
});

test('dev without secrets is fatal unless ALLOW_INSECURE_DEV is set', () => {
  const bare = { nodeEnv: 'development', webhookSecret: '', adminPassword: '', secretKey: '' };
  const prev = process.env.ALLOW_INSECURE_DEV;
  try {
    delete process.env.ALLOW_INSECURE_DEV;
    assert.ok(withConfig(bare, bootSafety).fatal.length > 0, 'dev must not silently run open by default');

    process.env.ALLOW_INSECURE_DEV = '1';
    const opted = withConfig(bare, bootSafety);
    assert.deepEqual(opted.fatal, [], 'an explicit opt-in must be honoured (npm run demo relies on this)');
    assert.ok(opted.warnings.length >= 3, 'and still say what is unprotected');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_INSECURE_DEV; else process.env.ALLOW_INSECURE_DEV = prev;
  }
});
