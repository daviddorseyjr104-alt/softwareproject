// SalesQL — ENRICHMENT.
// Given a LinkedIn profile URL, returns verified emails for that person.
// We keep only PERSONAL emails (per the blueprint: better deliverability / reply rate).
// Docs: GET https://api-public.salesql.com/v1/persons/enrich?linkedin_url=...
import { request, mapLimit } from '../http.js';
import { getSettings } from '../settings.js';

const ENRICH_URL = 'https://api-public.salesql.com/v1/persons/enrich';

// SalesQL is rate-limited (≈180 req/min on Pro). Keep concurrency modest.
const CONCURRENCY = 4;

/**
 * Enrich a batch of candidates (must each have `linkedinUrl`).
 * Adds `email` (+ `emailType`) to each; candidates with no usable email are dropped.
 * @returns {Promise<Array>} candidates that now have a usable email
 */
export async function enrichCandidates(candidates, log) {
  const config = getSettings();
  if (!config.salesql.apiKey) {
    throw new Error('SalesQL is not configured (SALESQL_API_KEY missing).');
  }

  const enriched = await mapLimit(candidates, CONCURRENCY, async (c) => {
    try {
      const email = await lookupEmail(c.linkedinUrl, log);
      if (!email) return null;
      return { ...c, email: email.address, emailType: email.type };
    } catch (err) {
      log.warn('salesql enrich failed', { linkedinUrl: c.linkedinUrl, error: err.message });
      return null; // one bad lookup shouldn't sink the batch
    }
  });

  const kept = enriched.filter(Boolean);
  log.info('salesql enrichment done', {
    input: candidates.length,
    withEmail: kept.length,
    personalOnly: config.salesql.personalOnly,
  });
  return kept;
}

/** Returns the best email {address,type} for a LinkedIn URL, or null. */
async function lookupEmail(linkedinUrl, log) {
  const config = getSettings();
  const url = `${ENRICH_URL}?linkedin_url=${encodeURIComponent(linkedinUrl)}`;
  const data = await request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.salesql.apiKey}`,
    },
    log,
  });

  // SalesQL returns an `emails` array; each item ~ { email, type: 'personal'|'professional', status }.
  const emails = Array.isArray(data.emails) ? data.emails : [];
  const usable = emails
    .map((e) => ({
      address: (e.email || '').trim().toLowerCase(),
      type: (e.type || '').toLowerCase(),
      status: (e.status || '').toLowerCase(),
    }))
    .filter((e) => e.address && looksLikeEmail(e.address));

  if (usable.length === 0) return null;

  // Prefer verified/valid over guessed, and personal over professional.
  const rank = (e) =>
    (e.type === 'personal' ? 2 : 0) +
    (['valid', 'verified', 'ok'].includes(e.status) ? 1 : 0);
  usable.sort((a, b) => rank(b) - rank(a));

  const best = usable.find((e) => (config.salesql.personalOnly ? e.type === 'personal' : true));
  return best ? { address: best.address, type: best.type || 'unknown' } : null;
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
