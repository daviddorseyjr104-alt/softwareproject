// The Approval Room brain: run a search/match in PREVIEW (no send), surface every candidate with
// the AI's reasoning and score breakdown, then COMMIT only the ones a human approved — skipping
// anyone on the suppression list or contacted too recently, and recording every real send.
//
// This is the human-in-the-loop path the admin UI drives. The webhook/CLI keep their own
// auto-send pipelines; this one never sends without an explicit commit.
import { getSettings } from './settings.js';
import { loadPool, loadCompanyTiers } from './pool.js';
import { matchCandidates, groupByCompany, preRank } from './matcher.js';
import { defaultProviders } from './pipeline.js';
import { dedupeByEmail } from './pipeline.js';
import { mapLimit } from './http.js';
import { isSuppressed } from './suppression.js';
import { lastContactAgeDays, recentlyContacted, recordContacts } from './contacts.js';
import { estimateCost } from './cost.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/** Annotate a sendable candidate with its safety flags (suppression + recent-contact). */
function annotate(c) {
  const age = lastContactAgeDays(c.email);
  return {
    ...c,
    suppressed: isSuppressed(c.email),
    lastContactDays: age,
  };
}

// ─── PREVIEW: whole-pool matching, no send ──────────────────────────
export async function previewPool(log, providers = defaultProviders) {
  const p = { ...defaultProviders, ...providers };
  const config = getSettings();
  const { roles } = loadPool();
  const { map: tierMap } = loadCompanyTiers();

  const summary = { kind: 'pool', status: 'preview', discovered: 0, prescreened: 0, enrichAttempts: 0, enriched: 0, matched: 0, aiUsed: false, groups: [] };

  // [1] Discover a WIDE net (cheap) and dedupe by LinkedIn.
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
  if (!discovered.length) { summary.status = 'no_candidates'; return finishPreview(summary); }

  // [2] Deterministically pre-rank the whole pool (free) and keep only the top finalists —
  //     so we spend SalesQL credits on the best candidates, not on everyone Apollo returned.
  const finalists = preRank(discovered, roles, tierMap).slice(0, config.apollo.maxCandidates).map((x) => x.candidate);
  summary.prescreened = finalists.length;
  summary.enrichAttempts = finalists.length;

  // [3] Enrich ONLY the finalists.
  const enriched = (await p.enrichCandidates(finalists, log)).filter((c) => c.email);
  summary.enriched = enriched.length;
  if (!enriched.length) { summary.status = 'no_emails'; return finishPreview(summary); }

  // [3b] Deep-profile: attach real GitHub engineering signal so scoring judges work, not titles.
  summary.githubMatched = await attachGithub(enriched, p, log);

  const { matches, aiUsed } = await matchCandidates(enriched, roles, tierMap, log);
  summary.aiUsed = aiUsed;
  summary.matched = matches.length;
  if (!matches.length) { summary.status = 'no_matches'; return finishPreview(summary); }

  for (const group of groupByCompany(matches)) {
    const roleTitle = group.matches[0].role.title;
    const roleSalary = group.matches[0].role.salary || '';
    summary.groups.push({
      company: group.company.name,
      roleTitle,
      roleSalary,
      candidates: group.matches.map((m) => annotate(candidateFromMatch(m, group.company.name, roleTitle, roleSalary))),
    });
  }
  return finishPreview(summary);
}

// ─── PREVIEW: single hiring company, no send ────────────────────────
export async function previewSearch(form, log, providers = defaultProviders) {
  const p = { ...defaultProviders, ...providers };
  const config = getSettings();
  const summary = { kind: 'single', status: 'preview', company: form.companyName, discovered: 0, enriched: 0, matched: 0, aiUsed: false, groups: [] };

  const discovered = await p.discoverCandidates(
    { titles: form.titles, location: form.location, limit: config.apollo.maxCandidates },
    log,
  );
  summary.discovered = discovered.length;
  if (!discovered.length) { summary.status = 'no_candidates'; return finishPreview(summary); }

  const enriched = dedupeByEmail(await p.enrichCandidates(discovered, log));
  summary.enriched = enriched.length;
  summary.matched = enriched.length;
  if (!enriched.length) { summary.status = 'no_emails'; return finishPreview(summary); }
  summary.githubMatched = await attachGithub(enriched, p, log);

  summary.groups.push({
    company: form.companyName,
    roleTitle: form.jobPosition || (form.titles || [])[0] || '',
    roleSalary: form.jobSalary || '',
    candidates: enriched.map((c) =>
      annotate(candidateFromEnriched(c, form.companyName, form.jobPosition || '', form.jobSalary || ''))),
  });
  return finishPreview(summary);
}

function finishPreview(summary) {
  summary.cost = estimateCost(summary);
  // A candidate is pre-approved (checkbox on) unless the system already knows better.
  let approvable = 0, blocked = 0;
  for (const g of summary.groups || []) {
    for (const c of g.candidates) {
      const ok = !c.suppressed && !recentlyContacted(c.email, dedupeWindow());
      c.blocked = !ok;
      c.blockReason = c.suppressed ? 'suppressed' : (!ok ? `contacted ${c.lastContactDays}d ago` : '');
      if (ok) approvable++; else blocked++;
    }
  }
  summary.approvable = approvable;
  summary.blocked = blocked;
  return summary;
}

// ─── COMMIT: send only the approved, safe candidates ────────────────
export async function commit(summary, approvedEmails, log, providers = defaultProviders) {
  const p = { ...defaultProviders, ...providers };
  const config = getSettings();
  const approved = new Set((approvedEmails || []).map(norm));
  const dryRun = config.dryRun;

  const result = {
    status: dryRun ? 'dry_run' : 'sent',
    dryRun,
    campaigns: [],
    sent: 0,
    skipped: { suppressed: 0, recent: 0, notApproved: 0 },
  };

  for (const group of summary.groups || []) {
    // Filter to approved AND safe.
    const leads = [];
    for (const c of group.candidates) {
      if (!approved.has(norm(c.email))) { result.skipped.notApproved++; continue; }
      if (isSuppressed(c.email)) { result.skipped.suppressed++; continue; }
      if (recentlyContacted(c.email, dedupeWindow())) { result.skipped.recent++; continue; }
      leads.push(c._lead);
    }
    if (!leads.length) continue;

    const formCtx = { companyName: group.company, jobPosition: group.roleTitle, jobSalary: group.roleSalary };

    if (dryRun) {
      result.campaigns.push({ company: group.company, added: leads.length, activated: false, dryRun: true });
      result.sent += leads.length;
      continue; // never touch Instantly or the contact log in dry-run
    }

    const campaign = await p.createCampaign(group.company, log);
    const { added } = await p.addLeads(campaign.id, leads, formCtx, log);
    const activated = await p.activateCampaign(campaign.id, log);
    recordContacts(leads.map((l) => ({ email: l.email, company: group.company, role: group.roleTitle, campaignId: campaign.id })));
    result.campaigns.push({ company: group.company, campaignId: campaign.id, added, activated });
    result.sent += added;
  }
  log?.info('approval commit done', result);
  return result;
}

// ─── helpers ────────────────────────────────────────────────────────
// Best-effort GitHub enrichment over the finalists (bounded concurrency). Mutates each
// candidate with `.github` and returns how many were confidently matched.
async function attachGithub(candidates, p, log) {
  if (typeof p.enrichGithub !== 'function') return 0;
  let matched = 0;
  await mapLimit(candidates, 3, async (c) => {
    try {
      const gh = await p.enrichGithub(c, log);
      if (gh) { c.github = gh; matched++; }
    } catch { /* never let GitHub sink a run */ }
  });
  return matched;
}

function dedupeWindow() {
  const n = Number(getSettings().dedupeWindowDays);
  return Number.isFinite(n) ? n : 0; // 0 = cross-run dedup off (default)
}

function candidateFromMatch(m, company, roleTitle, roleSalary) {
  const c = m.candidate;
  return {
    key: norm(c.email),
    name: c.fullName,
    email: c.email,
    emailType: c.emailType,
    score: m.score,
    role: roleTitle,
    company: c.company, // current employer
    linkedinUrl: c.linkedinUrl,
    breakdown: m.breakdown,
    ai: m.ai,
    github: c.github || null,
    _lead: leadOf(c, roleTitle, roleSalary),
  };
}

function candidateFromEnriched(c, company, roleTitle, roleSalary) {
  return {
    key: norm(c.email),
    name: c.fullName,
    email: c.email,
    emailType: c.emailType,
    score: null,
    role: c.title,
    company: c.company,
    linkedinUrl: c.linkedinUrl,
    breakdown: null,
    ai: null,
    github: c.github || null,
    _lead: leadOf(c, roleTitle, roleSalary),
  };
}

function leadOf(c, roleTitle) {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    fullName: c.fullName,
    email: c.email,
    company: c.company,
    title: c.title,
    linkedinUrl: c.linkedinUrl,
  };
}
