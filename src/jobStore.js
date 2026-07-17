// Durable job store so each submission is trackable via GET /jobs/:id and survives restarts.
// Backed by DATA_DIR/jobs.json (same public interface as the old in-memory version).
// On boot, any job left in `processing` is marked `interrupted` — a redeploy/crash killed its
// in-flight run, and the client should see the truth rather than a job stuck "processing" forever.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { bootConfig } from './config.js';

const MAX_JOBS = 500;
const JOBS_FILE = join(bootConfig.dataDir, 'jobs.json');

/** id -> job, insertion-ordered. Loaded once from disk. */
const jobs = loadFromDisk();

/**
 * Reconcile one job record read from disk against the fact that the process restarted.
 *
 * Exported so the restart paths can be tested without a real crash: `bootConfig.dataDir` is
 * resolved once at import, so a test can't point a fresh module instance at a fixture directory.
 *
 * @param {object} job a job as persisted
 * @returns {object} the same job, corrected in place
 */
export function reconcileOnLoad(job) {
  // A job still "processing" at boot means its run was killed mid-flight.
  if (job.status === 'processing') {
    job.status = 'failed';
    job.error = 'interrupted — the server restarted while this run was in progress';
    job.finishedAt = new Date().toISOString();
  }
  // A commit claim left 'in_progress' means the process died mid-send. Its outcome is genuinely
  // UNKNOWN — some campaigns may have gone out. Do NOT clear the claim (a blind retry could
  // email the same people twice) and do NOT leave it looking live either. Mark it interrupted so
  // the console can tell the operator to verify in Instantly and then decide.
  if (job.commit?.status === 'in_progress') {
    job.commit = {
      status: 'interrupted',
      startedAt: job.commit.startedAt,
      error: 'The server restarted while this launch was in flight. Some campaigns may have '
        + 'been created. Check Instantly before launching this run again.',
    };
  }
  return job;
}

function loadFromDisk() {
  const map = new Map();
  if (!existsSync(JOBS_FILE)) return map;
  try {
    const arr = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
    for (const job of Array.isArray(arr) ? arr : []) {
      map.set(job.id, reconcileOnLoad(job));
    }
  } catch {
    /* corrupt file → start empty */
  }
  return map;
}

function writeNow() {
  try {
    mkdirSync(bootConfig.dataDir, { recursive: true });
    const tmp = `${JOBS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify([...jobs.values()]));
    renameSync(tmp, JOBS_FILE); // atomic replace — a crash mid-write can't tear the file
  } catch {
    /* best-effort persistence — never crash the request path over a disk write */
  }
}

let writeQueued = false;
function persist() {
  // Coalesce rapid writes into one flush on the next tick.
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(() => {
    writeQueued = false;
    writeNow();
  });
}

/**
 * Write pending changes synchronously. Call on shutdown: `persist` defers to a microtask, so a
 * SIGTERM (every redeploy) could exit with the most recent job state still unwritten.
 */
export function flushJobs() {
  if (writeQueued) writeQueued = false;
  writeNow();
}

export function createJob(id, form) {
  const job = {
    id,
    status: 'processing', // processing | done | failed
    company: form.companyName,
    titles: form.titles,
    location: form.location,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
    error: null,
  };
  jobs.set(id, job);
  if (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
  persist();
  return job;
}

export function completeJob(id, summary) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.summary = summary;
  job.finishedAt = new Date().toISOString();
  persist();
}

export function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.error = error;
  job.finishedAt = new Date().toISOString();
  persist();
}

/** Merge arbitrary fields into a job (e.g. commit results after an approval). */
export function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  persist();
  return job;
}

/**
 * Atomically claim a job's commit slot. Returns true only for the FIRST caller.
 *
 * Sending outreach is not idempotent: without a claim written *before* the send, two
 * concurrent POSTs both read `commit == null`, both pass the guard, and both email the
 * same people. Node is single-threaded, so a synchronous test-and-set here is a real
 * mutex — the claim lands before any `await` can yield to the other request.
 */
export function claimCommit(id) {
  const job = jobs.get(id);
  if (!job || job.commit) return false;
  job.commit = { status: 'in_progress', startedAt: new Date().toISOString() };
  persist();
  return true;
}

/**
 * Force-release a claim the operator has explicitly acknowledged (an interrupted commit whose
 * outcome they've verified in Instantly). Deliberately manual: the server cannot know whether
 * the interrupted send went out, so only a human who has checked can authorize a retry.
 */
export function forceReleaseCommit(id) {
  const job = jobs.get(id);
  if (!job || !['in_progress', 'interrupted'].includes(job.commit?.status)) return false;
  job.commit = null;
  persist();
  return true;
}

/** Release a commit claim after a failed send, so the operator can retry. */
export function releaseCommit(id) {
  const job = jobs.get(id);
  if (job && job.commit?.status === 'in_progress') {
    job.commit = null;
    persist();
  }
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(limit = 50) {
  return [...jobs.values()].slice(-limit).reverse();
}
