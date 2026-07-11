# Getting & Testing the API Keys

This app talks to four external services. Three are required; one (Anthropic) is optional.
After you get each key, put it in `.env`, then run **`npm run test-keys`** — it makes one safe,
read-only call to each service and tells you which keys actually work (it creates nothing and
sends no email).

```bash
npm run test-keys
```

---

## 1. Apollo.io — candidate discovery (REQUIRED)

- **Get the key:** Log in to Apollo → **Settings → Integrations → API → API Keys → Create new key.**
- **Plan/cost:** API access is on **all plans, including free** (with per-minute/day rate limits).
  The free tier is enough to *test*; for real candidate volume a paid plan (~$49+/user/mo) is typical.
  The People **Search** endpoint this app uses (`/mixed_people/api_search`) does **not** consume credits.
- **Test it:** `npm run test-keys` calls Apollo's free `GET /v1/auth/health` — a ✅ means the key is live.
- Docs: <https://docs.apollo.io/docs/create-api-key> · <https://docs.apollo.io/docs/test-api-key>

## 2. SalesQL — personal-email enrichment (REQUIRED)

- **Get the key:** Log in to SalesQL → open the **API** page on your dashboard → copy the key.
- **⚠️ Plan/cost:** The SalesQL **API requires a paid plan (Professional or Organization).**
  **Free accounts get monthly credits but NO API access** — a free-account key returns `401`.
  Each enrichment that returns data costs **1 credit**.
- **Test it:** `npm run test-keys` probes a bogus profile (returns nothing → 0 credits) to prove auth.
- Docs: <https://docs.salesql.com/docs/api-pricing-and-rate-limits> · <https://help.salesql.com/en/articles/9449506-salesql-api-introduction>

## 3. Instantly.ai — email campaigns (REQUIRED)

- **Get the key:** Log in to Instantly → **Settings → Integrations → API** → create a **V2** key
  (must be v2 — v1 was deprecated Jan 2026).
- **Plan/cost:** API access is on the **Growth plan and above**. A free trial is available to test.
- **Test it:** `npm run test-keys` calls the read-only `GET /api/v2/campaigns?limit=1` (creates nothing).
- Docs: <https://developer.instantly.ai/api/v2/campaign/listcampaign>

## 4. Anthropic (Claude) — AI fit score (OPTIONAL)

- **Get the key:** <https://console.anthropic.com> → **API keys** → create key. Add a little credit
  (pay-as-you-go). Scoring uses `claude-opus-4-8` at `low` effort — cents per candidate.
- **If you skip it:** candidate scoring still runs on the other three signals (skills, seniority,
  pedigree) and reweights automatically. The app works without this key.
- **Test it:** `npm run test-keys` calls the free `GET /v1/models`.

---

## Once all required keys read ✅

```bash
npm run doctor            # should now show 100/100
npm run dry-run           # live Apollo + SalesQL, emails NOBODY — proves the data half
npm run match             # dry-run match over your pool: see scores, emails nobody
npm run match -- --live   # create the real Instantly campaigns
```

**Tip for a clean client demo:** keep `DRY_RUN=true` (or use a `Test Company` name) until you've
eyeballed the candidates and scores in the dry-run output. Flip to `--live` only when you're happy.
