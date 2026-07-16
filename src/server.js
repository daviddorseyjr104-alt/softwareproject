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
import { createJob, completeJob, failJob, getJob, listJobs, patchJob } from './jobStore.js';
import { checkAllKeys } from './keyCheck.js';
import { loadPool, getRawPool, getRawTiers, savePool, saveTiers } from './pool.js';
import { previewPool, previewSearch, commit } from './approval.js';
import { listSuppression, suppress, unsuppress } from './suppression.js';
import { contactCount, recentContacts } from './contacts.js';
import { estimateCost } from './cost.js';
import { requireAdmin, checkPassword, issueToken, sessionCookie, clearCookie, adminOpen } from './admin/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const adminPage = join(here, '..', 'public', 'admin.html');

function loginHtml(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate Finder — Admin login</title>
<style>
*{box-sizing:border-box}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;color:#e8eef8;margin:0;min-height:100vh;
  display:flex;align-items:center;justify-content:center;padding:1.5rem;-webkit-font-smoothing:antialiased;
  background:radial-gradient(1000px 500px at 20% -10%,rgba(99,102,241,.16),transparent 60%),radial-gradient(900px 450px at 100% 0%,rgba(139,92,246,.12),transparent 55%),#0a0e1a}
.card{background:linear-gradient(180deg,rgba(255,255,255,.02),transparent),#141d33;border:1px solid rgba(148,163,184,.14);
  padding:2rem 1.9rem;border-radius:18px;width:100%;max-width:360px;box-shadow:0 24px 60px -20px rgba(0,0,0,.7)}
.head{display:flex;align-items:center;gap:.7rem;margin-bottom:1.4rem}
.mark{width:38px;height:38px;border-radius:11px;flex:none;display:grid;place-items:center;font-size:1.15rem;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 8px 20px -6px rgba(99,102,241,.7)}
h1{font-size:1.05rem;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{font-size:.75rem;color:#5b6880;margin-top:1px}
label{display:block;font-size:.78rem;color:#8a97ad;margin:0 0 .4rem;font-weight:500}
input{width:100%;padding:.65rem .75rem;border-radius:10px;border:1px solid rgba(148,163,184,.24);background:#0d1424;color:#e8eef8;font:inherit;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.22)}
button{width:100%;margin-top:1.1rem;padding:.7rem;border:0;border-radius:10px;color:#fff;font:inherit;font-weight:600;cursor:pointer;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 10px 24px -10px rgba(99,102,241,.9);transition:filter .15s,transform .12s}
button:hover{filter:brightness(1.07);transform:translateY(-1px)}
.err{color:#f87171;font-size:.85rem;margin-bottom:.9rem;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.28);padding:.55rem .7rem;border-radius:9px}
</style></head>
<body><form class="card" method="POST" action="/admin/login">
<div class="head"><div class="mark">🎯</div><div><h1>Candidate Finder</h1><div class="sub">Admin sign in</div></div></div>
${error ? `<div class="err">${error}</div>` : ''}
<label for="pw">Admin password</label>
<input id="pw" type="password" name="password" placeholder="Enter your password" autofocus>
<button type="submit">Sign in</button></form></body></html>`;
}

// DEMO=true swaps real Apollo/SalesQL/Instantly for deterministic fakes (no keys, no network).
const DEMO = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEMO || '').toLowerCase());
const providers = DEMO ? demoProviders : defaultProviders;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Root: send visitors to the admin login (there's no public homepage) ---
app.get('/', (_req, res) => res.redirect('/admin/login'));

// --- Health check (no auth) ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', demo: DEMO, dryRun: getSettings().dryRun, ts: new Date().toISOString() });
});

// --- Shared-secret auth (constant-time compare) ---
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function authorized(req) {
  if (!bootConfig.webhookSecret) return true; // unauthenticated mode (dev only; refused in production)
  const provided = req.get('x-webhook-secret') || req.query.secret || '';
  return safeEqual(provided, bootConfig.webhookSecret);
}

// --- Main webhook ---
app.post('/webhook/candidate-finder', (req, res) => {
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

  // Acknowledge immediately — external calls can be slow and form webhooks time out.
  createJob(requestId, form);
  res.status(202).json({ status: 'accepted', requestId, company: form.companyName, trackUrl: `/jobs/${requestId}` });

  log.info('form accepted', { company: form.companyName, titles: form.titles, location: form.location });
  runPipeline(form, log, providers)
    .then((summary) => completeJob(requestId, summary))
    .catch((err) => {
      log.error('pipeline crashed', { error: err.message, stack: err.stack });
      failJob(requestId, err.message);
    });
});

// --- Run the multi-company matching engine over the pool (auth required if a secret is set) ---
app.post('/run-pool', (req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'pool' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  createJob(requestId, { companyName: 'POOL RUN', titles: [], location: '' });
  res.status(202).json({ status: 'accepted', requestId, trackUrl: `/jobs/${requestId}` });

  log.info('pool run accepted', { demo: DEMO });
  runPoolPipeline(log, providers)
    .then((summary) => completeJob(requestId, summary))
    .catch((err) => {
      log.error('pool pipeline crashed', { error: err.message, stack: err.stack });
      failJob(requestId, err.message);
    });
});

// --- Job status (auth required if a secret is set) ---
app.get('/jobs/:id', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json(job);
});

app.get('/jobs', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ jobs: listJobs(Number(req.query.limit) || 50) });
});

// ─── Admin: settings UI ────────────────────────────────────────────────────
// Login page (public).
app.get('/admin/login', (_req, res) => {
  res.type('html').send(loginHtml());
});
app.post('/admin/login', (req, res) => {
  if (!checkPassword(req.body?.password)) {
    return res.status(401).type('html').send(loginHtml('Wrong password.'));
  }
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

  createJob(requestId, form);
  res.status(202).json({ ok: true, requestId, company: form.companyName });

  log.info('admin search preview started', { company: form.companyName, titles: form.titles });
  previewSearch(form, log, providers)
    .then((summary) => completeJob(requestId, summary))
    .catch((err) => {
      log.error('admin search crashed', { error: err.message });
      failJob(requestId, err.message);
    });
});

// PREVIEW the whole pool-matching engine — score + match every role, but send NOTHING.
app.post('/admin/api/run-pool', (_req, res) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId, run: 'admin-pool' });

  createJob(requestId, { companyName: 'Pool matching run', titles: [], location: '' });
  res.status(202).json({ ok: true, requestId });

  log.info('admin pool preview started', { demo: DEMO });
  previewPool(log, providers)
    .then((summary) => completeJob(requestId, summary))
    .catch((err) => {
      log.error('admin pool run crashed', { error: err.message });
      failJob(requestId, err.message);
    });
});

// COMMIT: create campaigns + send outreach to ONLY the approved candidates from a preview job.
// Suppressed and recently-contacted people are skipped even if approved.
app.post('/admin/api/commit', async (req, res) => {
  const { requestId, approved } = req.body || {};
  const job = getJob(requestId);
  if (!job || !job.summary || !Array.isArray(job.summary.groups)) {
    return res.status(404).json({ ok: false, error: 'preview not found — run a search first' });
  }
  if (job.commit) return res.status(409).json({ ok: false, error: 'this run was already committed' });
  const log = logger.child({ requestId, run: 'admin-commit' });
  try {
    const result = await commit(job.summary, approved || [], log, providers);
    patchJob(requestId, { commit: result });
    res.json({ ok: true, result });
  } catch (err) {
    log.error('commit failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Suppression (do-not-contact) list management.
app.get('/admin/api/suppression', (_req, res) => {
  res.json({ ...listSuppression(), contactCount: contactCount(), recent: recentContacts(20) });
});
app.post('/admin/api/suppression', (req, res) => {
  const { add, remove } = req.body || {};
  if (add) suppress(add);
  if (remove) unsuppress(remove);
  res.json({ ok: true, ...listSuppression() });
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

// Readiness snapshot for the status panel.
app.get('/admin/api/status', (_req, res) => {
  const keys = getMaskedSettings().keys;
  let pool = { ok: false, detail: '' };
  try {
    const { companies, roles } = loadPool();
    pool = { ok: true, detail: `${companies.length} companies, ${roles.length} roles` };
  } catch (err) {
    pool = { ok: false, detail: err.message };
  }
  res.json({
    keys,
    pool,
    dryRun: getSettings().dryRun,
    demo: DEMO,
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

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info('shutting down', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export { app };
