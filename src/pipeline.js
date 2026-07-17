// Orchestrates the full flow for one form submission:
//   discover (Apollo) -> enrich (SalesQL) -> dedupe -> create campaign + add leads (Instantly)
//
// Providers are injected (see `defaultProviders`) so the pipeline can run against real APIs,
// the demo fakes, or test mocks without changing this file.
import { getSettings } from './settings.js';
import { discoverCandidates } from './providers/apollo.js';
import { enrichCandidates } from './providers/salesql.js';
import { createCampaign, addLeads, activateCampaign } from './providers/instantly.js';
import { enrichGithub } from './providers/github.js';
import { screenForSend } from './sendGate.js';
import { recordContacts } from './contacts.js';

export const defaultProviders = {
  discoverCandidates,
  enrichCandidates,
  enrichGithub,
  createCampaign,
  addLeads,
  activateCampaign,
};

/**
 * @param {object} form       normalized form (see form.js)
 * @param {object} log        request-scoped logger
 * @param {object} [providers] override any of defaultProviders (demo / tests)
 * @returns {Promise<object>} summary of what happened
 */
export async function runPipeline(form, log, providers = defaultProviders) {
  const p = { ...defaultProviders, ...providers };
  const config = getSettings();
  const startedAt = Date.now();

  // Per blueprint: test companies never send real email. Honor global DRY_RUN too.
  const isTestCompany = config.testCompanyNames.includes((form.companyName || '').toLowerCase());
  const dryRun = config.dryRun || isTestCompany;

  const summary = {
    company: form.companyName,
    titles: form.titles,
    location: form.location,
    dryRun,
    discovered: 0,
    enriched: 0,
    campaignId: null,
    campaignName: null,
    leadsAdded: 0,
    activated: false,
    status: 'ok',
  };

  // [1] Discovery
  const discovered = await p.discoverCandidates(
    { titles: form.titles, location: form.location, limit: config.apollo.maxCandidates },
    log,
  );
  summary.discovered = discovered.length;
  if (discovered.length === 0) {
    summary.status = 'no_candidates';
    summary.durationMs = Date.now() - startedAt;
    log.info('pipeline finished: no candidates discovered', summary);
    return summary;
  }

  // [2] Enrichment (personal emails). Drop dupes, then run the shared send gate — suppression
  // and the dedupe window apply to the automated webhook path, not just the admin approval flow.
  const enriched = await p.enrichCandidates(discovered, log);
  const { sendable: deduped, skipped } = screenForSend(dedupeByEmail(enriched), { log });
  summary.enriched = deduped.length;
  summary.skipped = skipped;

  // Per blueprint: if no qualified candidates with email, finish WITHOUT creating a campaign.
  if (deduped.length === 0) {
    summary.status = 'no_emails';
    summary.durationMs = Date.now() - startedAt;
    log.info('pipeline finished: candidates found but no usable emails', summary);
    return summary;
  }

  // [3] Outreach
  if (dryRun) {
    summary.status = 'dry_run';
    summary.sample = deduped.slice(0, 5).map((c) => ({
      name: c.fullName, email: c.email, emailType: c.emailType, title: c.title, company: c.company,
    }));
    summary.durationMs = Date.now() - startedAt;
    log.info('pipeline finished: DRY RUN (no Instantly campaign created)', { wouldAdd: deduped.length });
    return summary;
  }

  const campaign = await p.createCampaign(form.companyName, log);
  summary.campaignId = campaign.id;
  summary.campaignName = campaign.name;

  const { added } = await p.addLeads(campaign.id, deduped, form, log);
  summary.leadsAdded = added;

  summary.activated = await p.activateCampaign(campaign.id, log);
  // Record the send: the audit trail must cover every path that emails someone, and the
  // dedupe window can only protect people whose prior contact was actually written down.
  recordContacts(deduped.map((c) => ({
    email: c.email, company: form.companyName, role: form.jobPosition || '', campaignId: campaign.id,
  })));
  summary.durationMs = Date.now() - startedAt;
  log.info('pipeline finished', summary);
  return summary;
}

export function dedupeByEmail(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = (c.email || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
