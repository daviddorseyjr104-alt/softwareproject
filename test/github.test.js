import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = join(os.tmpdir(), 'cf-github-' + Math.random().toString(36).slice(2));

const { demoProviders } = await import('../src/providers/demo.js');
const settings = await import('../src/settings.js');
const { logger } = await import('../src/logger.js');
const quiet = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quiet[k] = () => {};

test('demo github enrichment extracts real languages from a headline', async () => {
  const gh = await demoProviders.enrichGithub(
    { firstName: 'Jordan', fullName: 'Jordan Ellis', company: 'Stripe', headline: 'Senior Backend Engineer — Go, Kubernetes, PostgreSQL, AWS' },
    quiet,
  );
  assert.ok(gh.matched);
  assert.ok(gh.topLanguages.includes('Go'));
  assert.ok(gh.topLanguages.includes('Kubernetes'));
  assert.ok(gh.publicRepos > 0 && gh.stars >= 0);
  assert.match(gh.url, /github\.com/);
});

test('github enrichment returns null when there is no code signal', async () => {
  const gh = await demoProviders.enrichGithub({ firstName: 'Pat', fullName: 'Pat Marks', headline: 'brand & marketing' }, quiet);
  assert.equal(gh, null);
});

test('github enrich respects the settings toggle (real provider)', async () => {
  const { enrichGithub } = await import('../src/providers/github.js');
  settings.updateSettings({ enrichGithub: false });
  const gh = await enrichGithub({ fullName: 'Somebody Real' }, quiet);
  assert.equal(gh, null); // feature off → no network call, no signal
  settings.updateSettings({ enrichGithub: true });
});

test('github key check reports unset gracefully (optional key)', async () => {
  const { checkGithubKey } = await import('../src/keyCheck.js');
  const r = await checkGithubKey('');
  assert.equal(r.status, 'unset');
  assert.match(r.detail, /unauthenticated/);
});
