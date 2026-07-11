// Instantly.ai (API v2) — OUTREACH.
// Creates a campaign named "[Company] – Candidate Outreach" and adds the enriched leads.
// Docs: https://developer.instantly.ai/  (v2; v1 was deprecated 2026-01-19)
//
// All endpoint paths & field names are centralized here so they are trivial to adjust
// if Instantly tweaks their v2 schema.
import { request, mapLimit } from '../http.js';
import { getSettings } from '../settings.js';

const BASE = 'https://api.instantly.ai/api/v2';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${getSettings().instantly.apiKey}`,
  };
}

function assertConfigured() {
  if (!getSettings().instantly.apiKey) {
    throw new Error('Instantly is not configured (INSTANTLY_API_KEY missing).');
  }
}

/**
 * Create a campaign. Returns the campaign id.
 * The schedule is required by v2; we build a Mon–Fri sending window from config.
 * If INSTANTLY_TEMPLATE_CAMPAIGN_ID is set, we copy its email sequence into the new campaign
 * so your drafted copy/follow-ups auto-apply (blueprint Step 4).
 */
export async function createCampaign(companyName, log) {
  assertConfigured();
  const config = getSettings();
  const name = `${companyName} – Candidate Outreach`;

  const body = {
    name,
    campaign_schedule: {
      schedules: [
        {
          name: 'Business hours',
          timing: { from: config.instantly.sendingFrom, to: config.instantly.sendingTo },
          // 0=Sun … 6=Sat — enable Mon–Fri.
          days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
          timezone: config.instantly.timezone,
        },
      ],
    },
  };

  // Optionally clone the email sequence from a template campaign.
  if (config.instantly.templateCampaignId) {
    const sequences = await fetchTemplateSequences(config.instantly.templateCampaignId, log);
    if (sequences) body.sequences = sequences;
  }

  const data = await request(`${BASE}/campaigns`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    log,
  });

  const id = data.id || data.campaign_id || data.data?.id;
  if (!id) throw new Error('Instantly did not return a campaign id on create.');
  log.info('instantly campaign created', { id, name });
  return { id, name };
}

/** Read a template campaign's `sequences` so a new campaign can reuse the copy. Best-effort. */
async function fetchTemplateSequences(templateId, log) {
  try {
    const tpl = await request(`${BASE}/campaigns/${templateId}`, {
      method: 'GET',
      headers: authHeaders(),
      log,
    });
    const sequences = tpl.sequences || tpl.data?.sequences;
    if (sequences) {
      log.info('instantly template sequence loaded', { templateId });
      return sequences;
    }
    log.warn('instantly template had no sequences; creating bare campaign', { templateId });
    return null;
  } catch (err) {
    log.warn('instantly template fetch failed; creating bare campaign', { templateId, error: err.message });
    return null;
  }
}

/**
 * Add enriched candidates as leads to a campaign.
 * v2 creates leads one object per POST /leads with a `campaign` field; we bound concurrency.
 * Personalization variables ({{firstName}}, {{company}}, {{jobTitle}}) are passed via custom_variables.
 * @returns {Promise<{added:number, failed:number}>}
 */
export async function addLeads(campaignId, candidates, form, log) {
  assertConfigured();

  let added = 0;
  let failed = 0;

  await mapLimit(candidates, 5, async (c) => {
    const body = {
      campaign: campaignId,
      email: c.email,
      first_name: c.firstName || undefined,
      last_name: c.lastName || undefined,
      company_name: c.company || undefined,
      // Deduplicate defensively across the workspace/campaign.
      skip_if_in_workspace: true,
      skip_if_in_campaign: true,
      custom_variables: {
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        company: c.company || '',
        jobTitle: c.title || '',
        linkedinUrl: c.linkedinUrl || '',
        // Context from the hiring company's form, useful in copy.
        hiringCompany: form.companyName || '',
        rolePosition: form.jobPosition || '',
        roleSalary: form.jobSalary || '',
      },
    };

    try {
      await request(`${BASE}/leads`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        log,
      });
      added++;
    } catch (err) {
      failed++;
      log.warn('instantly add lead failed', { email: c.email, error: err.message });
    }
  });

  log.info('instantly leads added', { campaignId, added, failed });
  return { added, failed };
}

/** Activate a campaign so it starts sending. Best-effort; logs but never throws fatally. */
export async function activateCampaign(campaignId, log) {
  assertConfigured();
  try {
    await request(`${BASE}/campaigns/${campaignId}/activate`, {
      method: 'POST',
      headers: authHeaders(),
      log,
    });
    log.info('instantly campaign activated', { campaignId });
    return true;
  } catch (err) {
    log.warn('instantly activate failed (campaign left in draft)', { campaignId, error: err.message });
    return false;
  }
}
