// The commit claim is what stops a double-click, a second tab, or a proxy retry from emailing
// everyone twice. Sending is not idempotent and Instantly offers no idempotency key, so this
// claim is the only thing between "launch" and "launch launch".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA = join(os.tmpdir(), 'cf-claim-' + Math.random().toString(36).slice(2));
mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

const store = await import('../src/jobStore.js');

test('only the FIRST caller wins the claim', () => {
  store.createJob('j1', { companyName: 'Acme', titles: [], location: '' });
  assert.equal(store.claimCommit('j1'), true, 'first caller must win');
  assert.equal(store.claimCommit('j1'), false, 'second concurrent caller must lose');
  assert.equal(store.claimCommit('j1'), false);
});

test('the claim is written synchronously — no await can interleave', () => {
  store.createJob('j2', { companyName: 'Acme', titles: [], location: '' });
  store.claimCommit('j2');
  // Written to the in-memory record before this line runs: that synchronicity IS the mutex.
  assert.equal(store.getJob('j2').commit.status, 'in_progress');
});

test('a failed commit releases the claim so the operator can retry', () => {
  store.createJob('j3', { companyName: 'Acme', titles: [], location: '' });
  assert.equal(store.claimCommit('j3'), true);
  store.releaseCommit('j3');
  assert.equal(store.claimCommit('j3'), true, 'a released claim must be re-claimable');
});

test('releaseCommit never clears a COMPLETED commit', () => {
  store.createJob('j4', { companyName: 'Acme', titles: [], location: '' });
  store.claimCommit('j4');
  store.patchJob('j4', { commit: { status: 'sent', sent: 12 } });
  store.releaseCommit('j4'); // must be a no-op — those 12 people were really emailed
  assert.equal(store.getJob('j4').commit.status, 'sent');
  assert.equal(store.claimCommit('j4'), false, 'a sent run must never be re-committable');
});

test('claiming an unknown job fails rather than inventing one', () => {
  assert.equal(store.claimCommit('does-not-exist'), false);
});

// What a redeploy or OOM kill in the middle of a launch leaves behind on disk.
test('a claim stranded by a crash comes back as interrupted, not as a live launch', () => {
  const crashed = store.reconcileOnLoad({
    id: 'crashed', status: 'done', company: 'Acme',
    summary: { groups: [] },
    commit: { status: 'in_progress', startedAt: '2026-01-01T00:01:00.000Z' },
  });
  assert.equal(crashed.commit.status, 'interrupted', 'a stranded claim must not still look in-flight');
  assert.match(crashed.commit.error, /Check Instantly/i, 'the operator must be told to verify before retrying');
  assert.equal(crashed.commit.startedAt, '2026-01-01T00:01:00.000Z', 'keep when it started');
});

test('a stranded claim blocks a blind retry but is recoverable by an operator', () => {
  store.createJob('j5', { companyName: 'Acme', titles: [], location: '' });
  store.patchJob('j5', store.reconcileOnLoad({
    id: 'j5', commit: { status: 'in_progress', startedAt: 'x' },
  }));
  // The server cannot know whether the interrupted send went out, so it must not decide.
  assert.equal(store.claimCommit('j5'), false, 'blind retry must stay blocked');
  // But a job must never be permanently stuck: the operator who checked Instantly can clear it.
  assert.equal(store.forceReleaseCommit('j5'), true);
  assert.equal(store.claimCommit('j5'), true);
});

test('reconcileOnLoad fails an interrupted RUN and leaves finished jobs alone', () => {
  const killed = store.reconcileOnLoad({ id: 'a', status: 'processing' });
  assert.equal(killed.status, 'failed');
  assert.match(killed.error, /restarted/);

  const fine = store.reconcileOnLoad({ id: 'b', status: 'done', commit: { status: 'sent', sent: 3 } });
  assert.equal(fine.status, 'done');
  assert.equal(fine.commit.status, 'sent', 'a completed launch must be left exactly as it was');
});
