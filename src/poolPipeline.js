// Multi-company matching pipeline:
//   for each open role -> discover (Apollo) -> merge/dedupe -> enrich (SalesQL)
//   -> score every candidate against every role + AI fit -> match to best-fit company
//   -> create one Instantly campaign per company with its matched candidates.
//
// Providers are injected (same pattern as pipeline.js) so this runs against real APIs,
// the demo fakes, or test mocks.
import { getSettings } from './settings.js';
import { loadPool, loadCompanyTiers } from './pool.js';
import { matchCandidates, groupByCompany } from './matcher.js';
import { defaultProviders } from './pipeline.js';

export async function runPoolPipeline(log, providers = defaultProviders) {
  const p = { ...defaultProviders, ...providers };
  const config = getSettings();
  const startedAt = Date.now();

  const { companies, roles, usingExample: poolExample } = loadPool();
  const { map: tierMap } = loadCompanyTiers();
  if (poolExample) log.warn('using data/companies.example.json — copy it to data/companies.json and edit');

  const summary = {
    companies: companies.length,
    roles: roles.length,
    discovered: 0,
    enriched: 0,
    matched: 0,
    campaigns: [],
    dryRun: config.dryRun,
    status: 'ok',
  };

  // [1] Discover candidates for every role, then merge + dedupe by LinkedIn URL.
  const byLinkedin = new Map();
  for (const role of roles) {
    const found = await p.discoverCandidates(
      { titles: role.searchTitles, location: role.location, limit: config.apollo.maxCandidates },
      log,
    );
    for (const c of found) {
      const key = (c.linkedinUrl || '').toLowerCase();
      if (key && !byLinkedin.has(key)) byLinkedin.set(key, c);
    }
  }
  const discovered = [...byLinkedin.values()];
  summary.discovered = discovered.length;
  if (discovered.length === 0) {
    summary.status = 'no_candidates';
    summary.durationMs = Date.now() - startedAt;
    log.info('pool pipeline finished: no candidates discovered', summary);
    return summary;
  }

  // [2] Enrich (personal emails). Drop anyone we can't reach.
  const enriched = (await p.enrichCandidates(discovered, log)).filter((c) => c.email);
  summary.enriched = enriched.length;
  if (enriched.length === 0) {
    summary.status = 'no_emails';
    summary.durationMs = Date.now() - startedAt;
    log.info('pool pipeline finished: no usable emails', summary);
    return summary;
  }

  // [3] Score + match to best-fit company/role.
  const { matches, unmatched, aiUsed } = await matchCandidates(enriched, roles, tierMap, log);
  summary.matched = matches.length;
  summary.aiUsed = aiUsed;
  if (matches.length === 0) {
    summary.status = 'no_matches';
    summary.durationMs = Date.now() - startedAt;
    log.info('pool pipeline finished: candidates found but none passed the score threshold', {
      ...summary, unmatched: unmatched.length,
    });
    return summary;
  }

  // [4] One campaign per company.
  const groups = groupByCompany(matches);
  for (const group of groups) {
    const companyName = group.company.name;
    const leads = group.matches.map((m) => toLead(m));

    if (config.dryRun) {
      summary.campaigns.push({
        company: companyName, dryRun: true, matched: leads.length,
        top: leads.slice(0, 5).map((l) => ({ name: l.fullName, email: l.email, score: l.score, role: l.title })),
      });
      continue;
    }

    const campaign = await p.createCampaign(companyName, log);
    const form = { companyName, jobPosition: group.matches[0].role.title };
    const { added } = await p.addLeads(campaign.id, leads, form, log);
    const activated = await p.activateCampaign(campaign.id, log);
    summary.campaigns.push({ company: companyName, campaignId: campaign.id, added, activated });
  }

  summary.status = config.dryRun ? 'dry_run' : 'ok';
  summary.durationMs = Date.now() - startedAt;
  log.info('pool pipeline finished', summary);
  return summary;
}

// Flatten a match into the candidate shape addLeads expects, carrying score/role for personalization.
function toLead(match) {
  return {
    ...match.candidate,
    score: match.score,
    title: match.role.title, // the role they're matched TO
    matchedRole: match.role.title,
    matchedCompany: match.role.company.name,
  };
}
