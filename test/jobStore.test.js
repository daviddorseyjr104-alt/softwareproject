import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

// Seed a data dir with a job left "processing" (simulating a crash mid-run) BEFORE import.
const dir = join(os.tmpdir(), 'cf-jobs-' + Math.random().toString(36).slice(2));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'jobs.json'), JSON.stringify([
  { id: 'stale', status: 'processing', company: 'Acme', createdAt: '2026-01-01T00:00:00Z', finishedAt: null, summary: null, error: null },
]));
process.env.DATA_DIR = dir;

const store = await import('../src/jobStore.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

test('a job left "processing" at boot is marked interrupted (failed)', () => {
  const j = store.getJob('stale');
  assert.equal(j.status, 'failed');
  assert.match(j.error, /interrupted/i);
});

test('create -> complete persists to disk and survives a reload', async () => {
  store.createJob('job1', { companyName: 'Beta', titles: ['Eng'], location: 'NYC' });
  store.completeJob('job1', { matched: 3 });
  await tick();
  const onDisk = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8'));
  const j = onDisk.find((x) => x.id === 'job1');
  assert.equal(j.status, 'done');
  assert.equal(j.summary.matched, 3);
});

test('failJob records the error', async () => {
  store.createJob('job2', { companyName: 'Gamma', titles: [], location: '' });
  store.failJob('job2', 'boom');
  assert.equal(store.getJob('job2').status, 'failed');
  assert.equal(store.getJob('job2').error, 'boom');
});
