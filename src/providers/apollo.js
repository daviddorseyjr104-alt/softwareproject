// Apollo.io — candidate DISCOVERY.
// Takes job title(s) + company location and returns a list of people WITH LinkedIn URLs.
// NOTE: The People Search endpoint does NOT return emails/phones (that's why SalesQL runs next).
// Docs: https://docs.apollo.io/reference/people-api-search
import { request } from '../http.js';
import { getSettings } from '../settings.js';

const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';

/**
 * Search Apollo for candidates.
 * @param {object} p
 * @param {string[]} p.titles      job titles to match (person only needs to match ONE)
 * @param {string}   p.location    "City, State" of the hiring company / desired candidate area
 * @param {number}   p.limit       max candidates to return
 * @param {object}   log
 * @returns {Promise<Array<{firstName,lastName,fullName,title,company,linkedinUrl,location}>>}
 */
export async function discoverCandidates({ titles, location, limit }, log) {
  const config = getSettings();
  if (!config.apollo.apiKey) {
    throw new Error('Apollo is not configured (APOLLO_API_KEY missing).');
  }

  const cap = limit ?? config.apollo.maxCandidates;
  const perPage = Math.min(100, cap);
  const collected = [];
  let page = 1;

  while (collected.length < cap) {
    const body = {
      person_titles: titles,
      person_locations: location ? [location] : undefined,
      person_seniorities: config.apollo.seniorities.length ? config.apollo.seniorities : undefined,
      page,
      per_page: perPage,
    };

    log.debug('apollo search', { page, titles, location });
    const data = await request(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Apollo authenticates via the X-Api-Key header (NOT Bearer). This was previously
        // `Authorization: Bearer` here while keyCheck.js used x-api-key — the two disagreed,
        // so "Test keys" could pass while real searches 401'd. Aligned to the documented header.
        'x-api-key': config.apollo.apiKey,
      },
      body: JSON.stringify(body),
      log,
    });

    const people = Array.isArray(data.people) ? data.people : [];
    for (const person of people) {
      const linkedinUrl = person.linkedin_url || '';
      if (!linkedinUrl) continue; // no LinkedIn URL => SalesQL can't enrich it => useless to us
      collected.push(normalize(person));
      if (collected.length >= cap) break;
    }

    const totalPages = data.pagination?.total_pages ?? 1;
    if (people.length === 0 || page >= totalPages) break;
    page++;
  }

  log.info('apollo discovery done', { found: collected.length, requested: cap });
  return collected;
}

function normalize(person) {
  const org = person.organization || {};
  return {
    firstName: person.first_name || '',
    lastName: person.last_name || '',
    fullName: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
    title: person.title || '',
    company: org.name || person.organization_name || '',
    linkedinUrl: person.linkedin_url || '',
    // Headline feeds skills-matching and the AI fit score — dropping it starved both
    // signals, leaving them to judge candidates on job title alone.
    headline: person.headline || person.title || '',
    location: [person.city, person.state, person.country].filter(Boolean).join(', '),
  };
}
