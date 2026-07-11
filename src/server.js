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
import { createJob, completeJob, failJob, getJob, listJobs } from './jobStore.js';
import { checkAllKeys } from './keyCheck.js';
import { loadPool, getRawPool, getRawTiers, savePool, saveTiers } from './pool.js';
import { requireAdmin, checkPassword, issueToken, sessionCookie, clearCookie, adminOpen } from './admin/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const adminPage = join(here, '..', 'public', 'admin.html');

function loginHtml(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate Finder — Admin login</title>
<style>body{font:16px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;padding:2rem;border-radius:12px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:1.1rem;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;margin-bottom:.75rem}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:.9rem;margin-bottom:.5rem}</style></head>
<body><form class="card" method="POST" action="/admin/login">
<h1>🔒 Candidate Finder — Admin</h1>
${error ? `<div class="err">${error}</div>` : ''}
<input type="password" name="password" placeholder="Admin password" autofocus>
<button type="submit">Sign in</button></form></body></html>`;
}

// DEMO=true swaps real Apollo/SalesQL/Instantly for deterministic fakes (no keys, no network).
const DEMO = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEMO || '').toLowerCase());
const providers = DEMO ? demoProviders : defaultProviders;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info('shutting down', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export { app };
