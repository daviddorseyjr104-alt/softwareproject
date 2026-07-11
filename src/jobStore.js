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

function loadFromDisk() {
  const map = new Map();
  if (!existsSync(JOBS_FILE)) return map;
  try {
    const arr = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
    for (const job of Array.isArray(arr) ? arr : []) {
      // A job still "processing" at boot means its run was killed mid-flight.
      if (job.status === 'processing') {
        job.status = 'failed';
        job.error = 'interrupted — the server restarted while this run was in progress';
        job.finishedAt = new Date().toISOString();
      }
      map.set(job.id, job);
    }
  } catch {
    /* corrupt file → start empty */
  }
  return map;
}

let writeQueued = false;
function persist() {
  // Coalesce rapid writes into one flush on the next tick.
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(() => {
    writeQueued = false;
    try {
      mkdirSync(bootConfig.dataDir, { recursive: true });
      const tmp = `${JOBS_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify([...jobs.values()]));
      renameSync(tmp, JOBS_FILE);
    } catch {
      /* best-effort persistence — never crash the request path over a disk write */
    }
  });
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

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(limit = 50) {
  return [...jobs.values()].slice(-limit).reverse();
}
