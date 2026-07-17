// Express webhook server: entry point for the Candidate Finder automation.
import express from 'express';
import crypto, { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootConfig, bootSafety } from './config.js';
import { getSettings, getMaskedSettings, updateSettings } from './settings.js';
import { logger } from './logger.js';
import { parseForm } from './form.js';
import { runPipeline, defaultProviders } from './pipeline.js';
import { runPoolPipeline } from './poolPipeline.js';
import { demoProviders } from './providers/demo.js';
import { createJob, completeJob, failJob, getJob, listJobs, patchJob, claimCommit, releaseCommit, forceReleaseCommit, flushJobs } from './jobStore.js';
import { checkAllKeys } from './keyCheck.js';
import { loadPool, getRawPool, getRawTiers, savePool, saveTiers } from './pool.js';
import { previewPool, previewSearch, commit } from './approval.js';
import { listSuppression, suppress, unsuppress } from './suppression.js';
import { contactCount, recentContacts } from './contacts.js';
import { estimateCost } from './cost.js';
import { requireAdmin, checkPassword, issueToken, sessionCookie, clearCookie, adminOpen } from './admin/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const adminPage = join(here, '..', 'public', 'admin.html');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// `error` is interpolated into HTML below. Every caller passes a literal today, so this is not
// exploitable — but the first change that surfaces a real message here (an err.message, a query
// param) would make it a live XSS on the unauthenticated login page. Escape at the sink.
function loginHtml(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate Finder — Admin login</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;font-size:14.5px;line-height:1.5;letter-spacing:-.006em;color:#0b1020;margin:0;min-height:100vh;
  display:flex;align-items:center;justify-content:center;padding:1.5rem;-webkit-font-smoothing:antialiased;background:#f6f7fb}
.card{background:#fff;border:1px solid #edeef2;padding:2.1rem 1.95rem;border-radius:16px;width:100%;max-width:370px;
  box-shadow:0 1px 2px rgba(11,16,32,.04),0 12px 40px -14px rgba(11,16,32,.18)}
.head{display:flex;align-items:center;gap:.7rem;margin-bottom:1.5rem}
.logo{width:38px;height:38px;flex:none;border-radius:11px;box-shadow:0 6px 16px -6px rgba(79,70,229,.5)}
h1{font-size:1.08rem;margin:0;font-weight:680;letter-spacing:-.02em}
.sub{font-size:.75rem;color:#98a0b0;margin-top:1px;font-weight:500}
label{display:block;font-size:.78rem;color:#5c6474;margin:0 0 .4rem;font-weight:550}
input{width:100%;padding:.64rem .78rem;border-radius:9px;border:1px solid #e0e2e9;background:#fff;color:#0b1020;font:inherit;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
button{width:100%;margin-top:1.15rem;padding:.7rem;border:0;border-radius:9px;color:#fff;font:inherit;font-weight:600;cursor:pointer;
  background:linear-gradient(135deg,#4f46e5,#2563eb);box-shadow:0 4px 14px -4px rgba(79,70,229,.5);transition:filter .13s}
button:hover{filter:brightness(1.05)}
.err{color:#be123c;font-size:.85rem;margin-bottom:.9rem;background:rgba(225,29,72,.07);border:1px solid rgba(225,29,72,.22);padding:.55rem .7rem;border-radius:8px}
</style></head>
<body><form class="card" method="POST" action="/admin/login">
<div class="head"><svg class="logo" viewBox="0 0 34 34" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="34" y2="34"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="34" height="34" rx="10" fill="url(#lg)"/><circle cx="15" cy="15" r="6" fill="none" stroke="#fff" stroke-width="2.1"/><line x1="19.4" y1="19.4" x2="24" y2="24" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/><path d="M22 8l.85 2.05L25 10.9l-2.15.85L22 14l-.85-2.25L19 10.9l2.15-.85z" fill="#fff"/></svg><div><h1>Candidate Finder</h1><div class="sub">Admin sign in</div></div></div>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
<label for="pw">Admin password</label>
<input id="pw" type="password" name="password" placeholder="Enter your password" autofocus>
<button type="submit">Sign in</button></form></body></html>`;
}

// DEMO=true swaps real Apollo/SalesQL/Instantly for deterministic fakes (no keys, no network).
const DEMO = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEMO || '').toLowerCase());
const providers = DEMO ? demoProviders : defaultProviders;

/**
 * Admission control for pipeline runs.
 *
 * Each run fans out to Apollo (~100 discoveries), SalesQL (~25 PAID enrichments), GitHub, and
 * one Claude call per candidate. The providers cap concurrency *within* a run; nothing capped it
 * *across* runs. Every request was acked 202 before any spend, so there was no backpressure at
 * all: N concurrent webhook posts meant N concurrent pipelines, N×25 paid lookups, and N×25
 * candidate arrays on the heap. Reject past the backlog rather than queue without bound — a
 * caller that gets 503 can retry; a silently queued run spends money nobody is waiting for.
 */
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS) || 2;
const MAX_QUEUED_RUNS = Number(process.env.MAX_QUEUED_RUNS) || 8;
let activeRuns = 0;
const runQueue = [];

function pump() {
  while (activeRuns < MAX_CONCURRENT_RUNS && runQueue.length) {
    const task = runQueue.shift();
    activeRuns++;
    task().finally(() => { activeRuns--; pump(); });
  }
}

/** True while there is room to admit another run. Check BEFORE creating the job record. */
const hasRunCapacity = () => activeRuns + runQueue.length < MAX_CONCURRENT_RUNS + MAX_QUEUED_RUNS;

/** Queue an admitted run. Call only after `hasRunCapacity()` and after the job record exists. */
function enqueueRun(task) {
  runQueue.push(task);
  pump();
}

const busyResponse = (res) =>
  res.status(503).json({ error: 'busy', detail: 'too many runs in progress — retry shortly' });

const app = express();

// Render/most PaaS terminate TLS upstream; without this req.ip is the proxy's address and the
// login rate limiter would bucket every attacker into one shared counter.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Security headers ---
// No external dependency: the app serves one inline-script console and a login page.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer'); // never let a URL carry a secret to a third party
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // The console's script is inline, so 'unsafe-inline' is required until it moves to a file.
  // frame-ancestors + a tight default-src still contain an injected payload's exfil options.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

/**
 * Fixed-window rate limiter, keyed per IP. In-memory by design — this process holds all the
 * state that matters (jobs, settings) in memory already, so a shared store would be the only
 * distributed thing here.
 */
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  // Sweep expired buckets so a botnet cycling IPs can't grow this map without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of hits) if (b.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const bucket = hits.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'too_many_requests', retryAfter });
    }
    next();
  };
  // Clear an IP's budget once it proves it knows the password. An attacker can't reach this
  // (they never authenticate), but an operator who fat-fingers their password a few times
  // shouldn't spend the next 15 minutes one typo away from locking themselves out.
  middleware.reset = (req) => hits.delete(req.ip || 'unknown');
  return middleware;
}

// ADMIN_PASSWORD is human-chosen and guards the API keys, live sending, and every candidate's
// personal email. Without a limit, a wordlist runs unattended at thousands of guesses/sec and the
// 302-vs-401 response is a perfect oracle — the constant-time compare is moot without this.
const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
// Discovery/enrichment spends real money per call, so the trigger routes get a ceiling too.
const runLimiter = rateLimiter({ windowMs: 60 * 1000, max: 20 });

// --- Root: send visitors to the admin login (there's no public homepage) ---
app.get('/', (_req, res) => res.redirect('/admin/login'));

// --- Health check (no auth) ---
// Liveness only. It used to report `dryRun`, which told an unauthenticated caller whether real
// email was flowing — a free signal for timing an attack. The console reads /admin/api/status.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// --- Shared-secret auth (constant-time compare) ---
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Authorize a webhook POST. Header only — never `?secret=`.
 *
 * A query-string secret leaks into access logs, proxy/CDN logs, browser history, and the
 * Referer header. Both GoHighLevel and Flowsa can send a custom header, so the query form
 * bought nothing and cost a credential. This secret authorizes SENDING work only; it is
 * deliberately not accepted anywhere that returns candidate PII (see /jobs below).
 */
function authorized(req) {
  if (!bootConfig.webhookSecret) return true; // unauthenticated mode (dev only; refused in production)
  return safeEqual(req.get('x-webhook-secret') || '', bootConfig.webhookSecret);
}

// --- Main webhook ---
app.post('/webhook/candidate-finder', runLimiter, (req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId });

  if (!authorized(req)) {
    log.warn('unauthorized webhook call');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { form, errors } = parseForm(req.body || {});
  if (errors.length) {
    log.warn('invalid form submission', { errors, receivedKeys: Object.keys(req.body || {}) });
    return res.status(422).json({ error: 'invalid_form', details: errors, requestId });
  }

  // Admit before acking: a 202 is a promise to spend money, so refuse it if we're saturated.
  if (!hasRunCapacity()) {
    log.warn('run rejected — queue full');
    return busyResponse(res);
  }

  // Acknowledge immediately — external calls can be slow and form webhooks time out.
  createJob(requestId, form);
  enqueueRun(() =>
    runPipeline(form, log, providers)
      .then((summary) => completeJob(requestId, summary))
      .catch((err) => {
        log.error('pipeline crashed', { error: err.message, stack: err.stack });
        failJob(requestId, err.message);
      }));
  res.status(202).json({ status: 'accepted', requestId, company: form.companyName, trackUrl: `/jobs/${requestId}` });
  log.info('form accepted', { company: form.companyName, titles: form.titles, location: form.location });
});

// --- Run the multi-company matching engine over the pool (auth required if a secret is set) ---
app.post('/run-pool', runLimiter, (req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'pool' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!hasRunCapacity()) return busyResponse(res);

  createJob(requestId, { companyName: 'POOL RUN', titles: [], location: '' });
  enqueueRun(() =>
    runPoolPipeline(log, providers)
      .then((summary) => completeJob(requestId, summary))
      .catch((err) => {
        log.error('pool pipeline crashed', { error: err.message, stack: err.stack });
        failJob(requestId, err.message);
      }));
  res.status(202).json({ status: 'accepted', requestId, trackUrl: `/jobs/${requestId}` });
  log.info('pool run accepted', { demo: DEMO });
});

// --- Job status (external tracking) ---
// A job summary carries every candidate's name, personal email, and LinkedIn URL. WEBHOOK_SECRET
// is shared with a third-party form vendor, so it authorizes *tracking* only and never sees a
// candidate: these routes return a PII-free projection. The admin console reads the full record
// through /admin/api/jobs, which is gated on the admin session instead.
const MAX_JOB_LIMIT = 100;

/** Counts and status only — no names, emails, LinkedIn URLs, or leads. */
function jobStatusView(job) {
  const s = job.summary;
  return {
    id: job.id,
    status: job.status,
    company: job.company,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    error: job.error,
    summary: s
      ? {
        kind: s.kind, status: s.status, discovered: s.discovered, enriched: s.enriched,
        matched: s.matched, approvable: s.approvable, blocked: s.blocked, aiUsed: s.aiUsed, cost: s.cost,
      }
      : null,
    sent: job.commit?.sent ?? null,
  };
}

app.get('/jobs/:id', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json(jobStatusView(job));
});

app.get('/jobs', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  // Cap the limit: `Number(req.query.limit) || 50` let a caller ask for every job ever run.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_JOB_LIMIT);
  res.json({ jobs: listJobs(limit).map(jobStatusView) });
});

// ─── Admin: settings UI ────────────────────────────────────────────────────
// Login page (public).
app.get('/admin/login', (_req, res) => {
  res.type('html').send(loginHtml());
});
app.post('/admin/login', loginLimiter, (req, res) => {
  if (!checkPassword(req.body?.password)) {
    logger.warn('failed admin login', { ip: req.ip });
    return res.status(401).type('html').send(loginHtml('Wrong password.'));
  }
  loginLimiter.reset(req);
  res.setHeader('Set-Cookie', sessionCookie(issueToken()));
  res.redirect('/admin');
});
app.post('/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearCookie());
  res.redirect('/admin/login');
});

// Everything under /admin (except the login page above) requires auth.
app.use('/admin', requireAdmin);

app.get('/admin', (_req, res) => res.sendFile(adminPage));

// --- Admin API ---
app.get('/admin/api/settings', (_req, res) => res.json(getMaskedSettings()));

app.post('/admin/api/settings', (req, res) => {
  try {
    const masked = updateSettings(req.body || {});
    logger.info('settings updated via admin');
    res.json({ ok: true, settings: masked });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Test keys — either the ones just typed in the form, or the saved/effective ones.
app.post('/admin/api/test-keys', async (req, res) => {
  const s = getSettings();
  const b = req.body || {};
  const results = await checkAllKeys({
    apollo: b.apollo || s.apollo.apiKey,
    salesql: b.salesql || s.salesql.apiKey,
    instantly: b.instantly || s.instantly.apiKey,
    anthropic: b.anthropic || s.ai.apiKey,
    github: b.github || s.github.apiKey,
  });
  res.json(results);
});

app.get('/admin/api/pool', (_req, res) => {
  try {
    res.json({ companies: getRawPool().data, tiers: getRawTiers().data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/pool', (req, res) => {
  try {
    if (req.body?.companies !== undefined) savePool(req.body.companies);
    if (req.body?.tiers !== undefined) saveTiers(req.body.tiers);
    logger.info('pool updated via admin');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/admin/api/jobs', (req, res) => {
  res.json({ jobs: listJobs(Number(req.query.limit) || 25) });
});

// Full detail for one run (status + summary/error) — powers the live results view.
app.get('/admin/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json(job);
});

// PREVIEW a single-company search from the admin UI — discover + enrich, but send NOTHING.
// The operator reviews candidates and commits the approved ones separately.
app.post('/admin/api/run-search', (req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'admin-search' });
  const { form, errors } = parseForm(req.body || {});
  if (errors.length) return res.status(422).json({ ok: false, errors });
  if (!hasRunCapacity()) return busyResponse(res);

  createJob(requestId, form);
  enqueueRun(() =>
    previewSearch(form, log, providers)
      .then((summary) => completeJob(requestId, summary))
      .catch((err) => {
        log.error('admin search crashed', { error: err.message });
        failJob(requestId, err.message);
      }));
  res.status(202).json({ ok: true, requestId, company: form.companyName });
  log.info('admin search preview started', { company: form.companyName, titles: form.titles });
});

// PREVIEW the whole pool-matching engine — score + match every role, but send NOTHING.
app.post('/admin/api/run-pool', (_req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'admin-pool' });
  if (!hasRunCapacity()) return busyResponse(res);

  createJob(requestId, { companyName: 'Pool matching run', titles: [], location: '' });
  enqueueRun(() =>
    previewPool(log, providers)
      .then((summary) => completeJob(requestId, summary))
      .catch((err) => {
        log.error('admin pool run crashed', { error: err.message });
        failJob(requestId, err.message);
      }));
  res.status(202).json({ ok: true, requestId });
  log.info('admin pool preview started', { demo: DEMO });
});

// COMMIT: create campaigns + send outreach to ONLY the approved candidates from a preview job.
// Suppressed and recently-contacted people are skipped even if approved.
app.post('/admin/api/commit', async (req, res) => {
  const { requestId, approved } = req.body || {};
  const job = getJob(requestId);
  if (!job || !job.summary || !Array.isArray(job.summary.groups)) {
    return res.status(404).json({ ok: false, error: 'preview not found — run a search first' });
  }
  // Claim the commit slot BEFORE any await. Two concurrent requests (double-click, two tabs,
  // a proxy retry) would otherwise both pass a read-only guard and email everyone twice.
  if (!claimCommit(requestId)) {
    // Say WHICH of the three states this is — the operator's next move differs for each.
    const state = job.commit?.status;
    const error = state === 'in_progress'
      ? 'This run is being launched right now — watch the Runs tab.'
      : state === 'interrupted'
        ? job.commit.error
        : 'This run was already launched. Launching again would email the same people twice.';
    return res.status(409).json({ ok: false, error, state });
  }
  const log = logger.child({ requestId, run: 'admin-commit' });
  try {
    const result = await commit(job.summary, approved || [], log, providers);
    patchJob(requestId, { commit: result });
    res.json({ ok: true, result });
  } catch (err) {
    log.error('commit failed', { error: err.message });
    // Release the claim only if NOTHING went out — then a retry is safe and the operator isn't
    // stuck. If any leads reached Instantly, keep the claim: a retry would re-email the groups
    // that already succeeded, and the dedupe window is no backstop (it defaults to 0/off).
    // The operator clears it via /admin/api/commit/:id/release once they've checked Instantly.
    if (err.partialSend) {
      patchJob(requestId, { commit: { status: 'interrupted', error: `Launch failed part-way: ${err.message}. Some campaigns were created — check Instantly before retrying.` } });
    } else {
      releaseCommit(requestId);
    }
    res.status(500).json({ ok: false, error: err.message, partialSend: Boolean(err.partialSend) });
  }
});

// Clear a stuck commit claim so an interrupted launch can be retried.
// Manual and explicit by design: when the process dies mid-send, the server cannot know whether
// the campaigns went out. Only an operator who has checked Instantly can answer that, so this
// is their acknowledgement — not something the server should ever decide on its own.
app.post('/admin/api/commit/:id/release', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'run not found' });
  if (job.commit?.status === 'sent' || job.commit?.sent > 0) {
    return res.status(409).json({ ok: false, error: 'this run completed its launch — retrying would email the same people twice' });
  }
  if (!forceReleaseCommit(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'this run has no stuck launch to clear' });
  }
  logger.warn('commit claim released by operator', { requestId: req.params.id });
  res.json({ ok: true });
});

// Suppression (do-not-contact) list management.
app.get('/admin/api/suppression', (_req, res) => {
  res.json({ ...listSuppression(), contactCount: contactCount(), recent: recentContacts(20) });
});
app.post('/admin/api/suppression', (req, res) => {
  const { add, remove } = req.body || {};
  // suppress/unsuppress throw on an invalid value or a failed disk write — both are things the
  // operator can act on ("john is not a valid email or domain"), so return the message rather
  // than letting it fall through to the generic 500 handler.
  try {
    if (add) suppress(add);
    if (remove) unsuppress(remove);
    res.json({ ok: true, ...listSuppression() });
  } catch (err) {
    logger.warn('suppression update rejected', { error: err.message });
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Funnel + spend rollup across recent runs.
app.get('/admin/api/funnel', (_req, res) => {
  const jobs = listJobs(100).filter((j) => j.summary && Array.isArray(j.summary.groups));
  const agg = { runs: jobs.length, discovered: 0, enriched: 0, matched: 0, sent: 0, cost: 0 };
  for (const j of jobs) {
    const s = j.summary;
    agg.discovered += s.discovered || 0;
    agg.enriched += s.enriched || 0;
    agg.matched += s.matched || 0;
    agg.sent += j.commit?.sent || 0;
    agg.cost += (s.cost?.total) ?? estimateCost(s).total;
  }
  agg.cost = Math.round(agg.cost * 100) / 100;
  res.json(agg);
});

// Readiness snapshot for the status panel + onboarding checklist.
app.get('/admin/api/status', (_req, res) => {
  const keys = getMaskedSettings().keys;
  let pool = { ok: false, detail: '' };
  let poolExample = false;
  let poolRoles = 0;
  try {
    const { companies, roles, usingExample } = loadPool();
    pool = { ok: true, detail: `${companies.length} companies, ${roles.length} roles` };
    poolRoles = roles.length; // the console needs this to estimate a pool run's cost BEFORE it runs
    poolExample = usingExample;
  } catch (err) {
    pool = { ok: false, detail: err.message };
  }
  // What's actually needed to DO things: preview needs discovery+enrichment; sending needs Instantly.
  const canPreview = DEMO || (keys.apollo.set && keys.salesql.set);
  const canSend = DEMO || keys.instantly.set;
  res.json({
    keys,
    pool,
    poolRoles,
    poolExample,
    dryRun: getSettings().dryRun,
    demo: DEMO,
    canPreview,
    canSend,
    ready: canPreview && pool.ok,
    webhookSecretSet: Boolean(bootConfig.webhookSecret),
    adminProtected: !adminOpen(),
  });
});

// --- 404 + error handlers ---
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('unhandled express error', { error: err.message });
  res.status(500).json({ error: 'internal_error' });
});

// --- Boot safety: refuse to start unsafely in production ---
const { fatal, warnings } = bootSafety();
for (const w of warnings) logger.warn('boot check', { warning: w });
if (fatal.length) {
  for (const f of fatal) logger.error('boot check FAILED', { fatal: f });
  logger.error('refusing to start — set the required secrets (see docs/DEPLOY.md)');
  process.exit(1);
}

const server = app.listen(bootConfig.port, () => {
  logger.info('candidate-finder server listening', {
    port: bootConfig.port, demo: DEMO, env: bootConfig.nodeEnv, dryRun: getSettings().dryRun,
  });
  if (DEMO) {
    logger.warn('DEMO MODE — using fake providers; no real API calls or emails');
  } else {
    const keys = getMaskedSettings().keys;
    const present = Object.entries(keys).filter(([, k]) => k.set).map(([n]) => n);
    logger.info('key status at boot', { configured: present, note: 'keys can also be set at /admin' });
  }
});

// --- Automated sourcing: re-run the pool PREVIEW on a cadence (never auto-sends) ---
// Every firing produces a preview job the operator reviews and approves in the Approval Room.
let lastScheduledRun = Date.now(); // wait one full interval before the first run
const scheduler = setInterval(() => {
  const hours = getSettings().scheduleHours;
  if (!hours || hours <= 0) return;
  if (Date.now() - lastScheduledRun < hours * 3600 * 1000) return;
  lastScheduledRun = Date.now();
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'scheduled' });
  createJob(requestId, { companyName: 'Scheduled pool preview', titles: [], location: '' });
  log.info('scheduled pool preview started', { everyHours: hours });
  previewPool(log, providers)
    .then((summary) => completeJob(requestId, summary))
    .catch((err) => failJob(requestId, err.message));
}, 60 * 1000);
scheduler.unref(); // don't keep the process alive just for the scheduler

// --- Crash safety ---
// Node kills the process on an unhandled rejection. With none of these handlers, a single stray
// promise anywhere took down every in-flight run — each one then surfaced as
// "interrupted — the server restarted" with the operator's paid discovery work already spent.
// Log and stay up: a rejection in one candidate's enrichment must not cost the whole batch.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection — staying up', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// An uncaught exception leaves the process in an unknown state, so here we DO exit — but
// deliberately, after flushing the log, rather than dying silently mid-write.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception — shutting down', { error: err.message, stack: err.stack });
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info('shutting down', { signal: sig });
    flushJobs(); // persist() defers to a microtask; a redeploy could otherwise drop the last write
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export { app };
