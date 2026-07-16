# Kaizen Candidate Finder — Automation Backend

Backend for the Candidate Finder automation. A hiring-company form (GoHighLevel / Flowsa)
posts a webhook here; the backend discovers candidates, pulls their **personal** emails, and
loads them into an **Instantly** outreach campaign.

## The pipeline

```
Flowsa / GoHighLevel form
        │  (webhook POST)
        ▼
[1] Apollo.io  — search people by job title + location → list of people + LinkedIn URLs
        ▼
[2] SalesQL    — enrich each LinkedIn URL → verified PERSONAL email
        ▼
[3] Instantly  — create "[Company] – Candidate Outreach" campaign, add leads, activate
```

### ⚠️ Important: why Apollo is here
The original blueprint said *"SalesQL searches LinkedIn for candidates by job title."*
**SalesQL cannot do that** — its API only *enriches* a person you already have (via LinkedIn URL).
It has no search/discovery endpoint. So Apollo provides discovery ([1]); SalesQL does the
personal-email enrichment it's actually good at ([2]). Swapping Apollo for another provider is a
single-file change: [`src/providers/apollo.js`](src/providers/apollo.js).

## Two ways to run it

**1. Single-company webhook** (`/webhook/candidate-finder`) — a form submits one company + role, and everyone found gets emailed. Simple.

**2. Multi-company matching engine** (`npm run match`) — the real talent-matching brain. You maintain a pool of companies + open roles ([data/companies.json](data/companies.json)); the engine discovers candidates for every role, **scores each candidate** on four signals, **matches** each to their best-fit company, and creates one campaign per company with only the top matches.

### How candidates are found (best-first, spend-smart)

The engine casts a **wide net** (`DISCOVER_LIMIT`, ~100/role), **pre-ranks the whole pool for free** on the deterministic signals, keeps the **top finalists** (`MAX_CANDIDATES`), and enriches **only those** — so paid SalesQL credits go to the best candidates, not to everyone Apollo returned.

### How candidates are scored (0–100 composite)

| Signal | Weight | How |
|---|---|---|
| **AI fit** | 0.40 | Claude (`claude-opus-4-8`) reads the candidate vs. the role — including **real GitHub evidence** (repos, stars, languages) when found — and returns a fit score + reasoning. **Optional** — needs `ANTHROPIC_API_KEY`; if absent, the composite reweights to the other three. |
| **Skills match** | 0.25 | Role's required/nice-to-have skills matched against the candidate's title + headline |
| **Seniority** | 0.20 | Candidate's level vs. the role's desired seniority |
| **Pedigree** | 0.15 | Candidate's current employer looked up in [data/company-tiers.json](data/company-tiers.json) (tier 1 = elite) |

**Deep-profile enrichment:** finalists are matched to their real **GitHub** profile (`src/providers/github.js`) so "best" reflects shipped code, not a job title. Best-effort and optional — `GITHUB_TOKEN` lifts the rate limit but isn't required.

Weights and the accept `SCORE_THRESHOLD` are configurable in `.env`. Only candidates ≥ threshold are matched, and each role has a `capacity` cap — the highest scores claim the seats.

### The admin console: preview → approve → send

The `/admin` UI is a review console, not a fire-and-forget button:

1. **Preview** — run a single-company search or match the whole pool. It discovers, scores, and enriches, but **sends nothing**.
2. **Review** — every candidate is a card with the AI's reasoning, matched/missing skills, score breakdown, and GitHub signal. Suppressed or recently-contacted people are flagged and auto-excluded.
3. **Approve & launch** — check the ones you want, hit **Launch** — only then are campaigns created and outreach sent.

Built-in guardrails: a **do-not-contact list** (emails or whole domains), **cross-run dedup** (`DEDUPE_WINDOW_DAYS`), an **immutable contact audit trail**, per-run **cost estimates**, a lifetime **funnel**, and optional **scheduled sourcing** (`SCHEDULE_HOURS`) that generates previews for review without ever auto-sending.

### Run the matcher

```bash
npm run match          # DRY RUN — scores + matches, creates NOTHING in Instantly
npm run match -- --demo # full flow with fake providers, no keys/credits at all
npm run match -- --live # actually create the Instantly campaigns
```

## Deploying for a client (self-serve, hosted)

This runs as a hosted app the client configures themselves in a browser — no terminal, no files:

1. Deploy to a managed host (Render config included). Full runbook: **[docs/DEPLOY.md](docs/DEPLOY.md)**.
2. The client opens **`https://<your-host>/admin`** (password-protected), pastes *their own* API keys,
   clicks **Test keys** (✅/❌ per service), and edits their company/role list — all in the browser.
3. They point their GoHighLevel/Flowsa form at `https://<your-host>/webhook/candidate-finder?secret=…`.

Keys are the client's own (their accounts, their billing) and are **stored encrypted at rest**. In
production the app refuses to boot without its secrets, so it can't be left open by accident. Settings
and job history live on a persistent disk, so they survive restarts. One deployment = one client.

Required host env vars (set in the platform's secret store): `NODE_ENV=production`, `WEBHOOK_SECRET`,
`ADMIN_PASSWORD`, `SECRET_KEY`, `DATA_DIR`. API keys can be entered in the `/admin` UI *or* supplied
as env vars (`APOLLO_API_KEY`, `SALESQL_API_KEY`, `INSTANTLY_API_KEY`, `ANTHROPIC_API_KEY`) — the app
uses whichever is present.

## Setup (local dev)

```bash
npm install
cp .env.example .env      # then edit .env with your real keys
npm run check-config      # verify keys are loaded
```

Get the keys (full walkthrough + costs + free options in **[docs/GETTING-KEYS.md](docs/GETTING-KEYS.md)**):
- **APOLLO_API_KEY** — Apollo → Settings → Integrations → API. API is on all plans (free tier works to test).
- **SALESQL_API_KEY** — SalesQL dashboard → API page. ⚠️ **requires a paid plan** (free accounts have no API).
- **INSTANTLY_API_KEY** — Instantly → Settings → Integrations → API (must be **v2**; Growth plan+).
- **ANTHROPIC_API_KEY** — optional; console.anthropic.com. Enables the Claude AI fit score.

Then **verify the keys actually work** (safe, read-only, creates nothing):

```bash
npm run test-keys
```

## Run

```bash
npm start           # production
npm run dev         # auto-reload while developing
```

Server exposes:
- `GET  /health` — health check (no auth)
- `GET  /admin` — password-protected settings UI (keys, scoring, pool, jobs)
- `POST /webhook/candidate-finder` — the form webhook (secret-protected)
- `POST /run-pool` — run the multi-company matching engine over your pool (secret-protected)
- `GET  /jobs/:id` — status + result of one submission (secret-protected)
- `GET  /jobs` — recent submissions (secret-protected)

Every submission returns a `requestId` + `trackUrl`; poll `GET /jobs/:id` to see it go
`processing → done` (or `failed`) with the full result summary.

## See it work right now — no keys, no credits

```bash
npm run demo     # boots on :3999 with fake providers (DEMO mode)
```

Then in another terminal:

```bash
curl -X POST "http://localhost:3999/webhook/candidate-finder?secret=demo-secret" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Acme Builders","companyCity":"Denver","companyState":"Colorado","jobPositionName":"Senior Project Manager","positionsIAmLookingFor":"Project Manager, Estimator"}'
```

You'll watch the full flow run (discover → enrich → campaign → leads → activate) against
deterministic fakes. This exercises the real orchestration, form parsing, job tracking, and
error handling — only the three external APIs are stubbed.

## Automated tests

```bash
npm test         # node's built-in runner; no keys or network needed
```

Covers form parsing, HTTP retry/backoff + concurrency, the personal-email filter, and every
pipeline branch (happy path, no candidates, no emails, forced dry-run, dedupe).

### Point the form at it
In GoHighLevel/Flowsa, set the form's webhook/automation to POST to:

```
https://YOUR_HOST/webhook/candidate-finder
```

Add authentication as **either**:
- header `x-webhook-secret: <your WEBHOOK_SECRET>`, or
- query string `?secret=<your WEBHOOK_SECRET>`

The webhook accepts JSON or url-encoded form posts and tolerates GHL's nested `customData`.
It responds `202 Accepted` immediately, then runs the pipeline in the background (so the form
never times out). Field names are matched fuzzily — see [`src/form.js`](src/form.js).

## Test safely before going live

```bash
npm run dry-run
```

Runs Apollo + SalesQL **for real** (uses live credits) but creates **nothing** in Instantly and
prints a summary + sample leads. Customize:

```bash
COMPANY="Acme Builders" CITY="Denver" STATE="Colorado" TITLE="Estimator" npm run dry-run
```

Two independent safety switches keep real emails from going out:
- `DRY_RUN=true` in `.env` — global off-switch for Instantly.
- `TEST_COMPANY_NAMES` — any submission with these company names is auto–dry-run
  (defaults include `Test Company`, per the blueprint).

## Configuration (`.env`)

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `WEBHOOK_SECRET` | Shared secret for the webhook. **Blank = unauthenticated** (dev only) |
| `APOLLO_API_KEY` | Apollo master key (discovery) |
| `MAX_CANDIDATES` | Cap per submission. Each = 1 SalesQL credit. Default 25 |
| `APOLLO_SENIORITIES` | Seniority filter, e.g. `manager,director,senior` |
| `SALESQL_API_KEY` | SalesQL bearer token (enrichment) |
| `PERSONAL_EMAILS_ONLY` | `true` = only push personal emails (default) |
| `INSTANTLY_API_KEY` | Instantly v2 key (outreach) |
| `INSTANTLY_TIMEZONE` / `_SENDING_FROM` / `_SENDING_TO` | Campaign sending window |
| `DRY_RUN` | `true` = never touch Instantly |
| `TEST_COMPANY_NAMES` | Company names that force dry-run |

## Behavior notes
- **No candidates found** → pipeline finishes cleanly, no campaign created (matches the blueprint).
- **Candidates but no usable emails** → same: finishes, no campaign.
- Emails are **deduplicated** before loading; failed lookups are skipped, not fatal.
- All external calls retry with backoff on 429/5xx and respect `Retry-After`.

## What you still need to do in the SaaS tools
This backend creates the campaign and loads leads. **Email copy, sender identity, and follow-up
timing live in Instantly** — set up your sequence there (optionally via
`INSTANTLY_TEMPLATE_CAMPAIGN_ID`). Personalization variables passed per lead:
`{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{jobTitle}}`, `{{linkedinUrl}}`,
`{{hiringCompany}}`, `{{rolePosition}}`, `{{roleSalary}}`.

## ⚖️ Compliance
This pipeline collects personal emails and sends cold outreach. Depending on your recipients and
jurisdiction, **GDPR / CAN-SPAM / CCPA** and LinkedIn's ToS may apply. Make sure you have a lawful
basis, honest sender identity, and working unsubscribe before running this against real people.

## Layout
```
src/
  server.js            Express app + webhook route
  config.js            env loading + validation
  form.js              GHL/Flowsa payload → normalized form
  pipeline.js          orchestrates discovery → enrich → outreach
  http.js              fetch wrapper (timeout, retry, concurrency)
  logger.js            structured JSON logging
  providers/
    apollo.js          [1] discovery
    salesql.js         [2] enrichment
    instantly.js       [3] outreach
  providers/
    demo.js            fake providers for DEMO mode
  config.js            BOOT-only config (port, secrets, data dir) + production boot guard
  settings.js          runtime settings (keys/weights/pool toggles) — encrypted, UI-editable
  keyCheck.js          shared live key verification (CLI + admin "Test keys")
  jobStore.js          durable, disk-backed submission tracking (survives restarts)
  admin/auth.js        admin session auth (signed cookie)
  pool.js              load/validate/save the company+role pool and tier list
  matcher.js           score candidates + match to best-fit company (capacity-aware)
  poolPipeline.js      discover -> enrich -> score/match -> per-company campaigns
  scoring/
    seniority.js       seniority/level signal
    skills.js          skills/tech-stack signal
    pedigree.js        employer-tier signal
    aiFit.js           Claude fit score (structured output; graceful no-key fallback)
    score.js           composite (weighted blend + reweight when AI off)
data/
  companies.json       your pool of companies + open roles (falls back to .example)
  company-tiers.json   employer pedigree tiers (falls back to .example)
scripts/
  check-config.js      validate .env
  dry-run.js           safe single-company test (live Apollo+SalesQL, no Instantly)
  demo.js              launch DEMO mode server
  match.js             run the multi-company matching engine
  doctor.js            readiness report (npm run doctor) — scores how close to live you are
public/admin.html      the settings UI
Dockerfile, render.yaml  deployment (see docs/DEPLOY.md)
test/                  automated tests (npm test)
```
