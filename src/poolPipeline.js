// Multi-company matching pipeline:
//   for each open role -> discover (Apollo) -> merge/dedupe -> enrich (SalesQL)
//   -> score every candidate against every role + AI fit -> match to best-fit company
//   -> create one Instantly campaign per company with its matched candidates.
//
// Providers are injected (same pattern as pipeline.js) so this runs against real APIs,
// the demo fakes, or test mocks.
import { getSettings } from './settings.js';
import { loadPool, loadCompanyTiers } from './pool.js';
import { matchCandidates, groupByCompanyRole, preRank } from './matcher.js';
import { mapLimit } from './http.js';
import { defaultProviders } from './pipeline.js';
import { screenForSend } from './sendGate.js';
import { recordContacts } from './contacts.js';

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

  // [1] Discover a WIDE net for every role, then merge + dedupe by LinkedIn URL.
  const byLinkedin = new Map();
  for (const role of roles) {
    const found = await p.discoverCandidates(
      { titles: role.searchTitles, location: role.location, limit: config.apollo.discoverLimit },
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

  // [2] Pre-rank the wide pool (free) and keep the top finalists — enrich only the best.
  const finalists = preRank(discovered, roles, tierMap).slice(0, config.apollo.maxCandidates).map((x) => x.candidate);
  summary.prescreened = finalists.length;
  summary.enrichAttempts = finalists.length;

  // [3] Enrich ONLY the finalists (the paid step). Drop anyone we can't reach, then run the
  //     do-not-contact + recently-contacted gate. This path auto-sends with no human review,
  //     so the gate is the ONLY thing standing between a suppressed address and an email.
  const withEmail = (await p.enrichCandidates(finalists, log)).filter((c) => c.email);
  const { sendable: enriched, skipped } = screenForSend(withEmail, { log });
  summary.enriched = enriched.length;
  summary.skipped = skipped;

  // [3b] Attach real GitHub engineering signal (best-effort) before scoring.
  if (typeof p.enrichGithub === 'function') {
    await mapLimit(enriched, 3, async (c) => {
      try { const gh = await p.enrichGithub(c, log); if (gh) c.github = gh; } catch { /* best-effort */ }
    });
  }
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

  // [4] One campaign per (company, role) — a company with two open roles needs two campaigns,
  //     or the second role's candidates get pitched the first role's job and salary.
  const groups = groupByCompanyRole(matches);
  for (const group of groups) {
    const companyName = group.company.name;
    const roleTitle = group.role.title;
    const leads = group.matches.map((m) => toLead(m));

    if (config.dryRun) {
      summary.campaigns.push({
        company: companyName, role: roleTitle, dryRun: true, matched: leads.length,
        top: leads.slice(0, 5).map((l) => ({ name: l.fullName, email: l.email, score: l.score, role: l.title })),
      });
      continue;
    }

    const campaign = await p.createCampaign(companyName, log, roleTitle);
    const form = { companyName, jobPosition: roleTitle, jobSalary: group.role.salary || '' };
    const { added } = await p.addLeads(campaign.id, leads, form, log);
    const activated = await p.activateCampaign(campaign.id, log);
    // Record the send. Without this the "immutable audit trail" silently omitted every pool
    // run, and dedupeWindowDays could never fire for this path — it reads data nobody wrote.
    recordContacts(leads.map((l) => ({
      email: l.email, company: companyName, role: roleTitle, campaignId: campaign.id,
    })));
    summary.campaigns.push({ company: companyName, role: roleTitle, campaignId: campaign.id, added, activated });
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
    // `title` stays the candidate's CURRENT job — it feeds the {{jobTitle}} variable, and the
    // role they're being pitched already travels separately as {{rolePosition}}. This used to
    // be overwritten with match.role.title, so {{jobTitle}} meant "their current job" in the
    // approval path and "the job we're offering" here: the same variable, opposite meanings,
    // and whichever way the copy was written, one of the two paths sent nonsense.
    title: match.candidate.title,
    matchedRole: match.role.title,
    matchedCompany: match.role.company.name,
  };
}
