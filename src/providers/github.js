// GitHub deep-profile enrichment — the missing "real engineering signal".
// Apollo gives a title and a headline; this finds the candidate's actual GitHub and reads what
// they've built: public repos, stars earned, followers, and the languages they actually ship.
// That evidence is fed to the AI fit score and shown to the reviewer, so "best" reflects real
// work — not a job title.
//
// Best-effort by design: person↔GitHub matching is inherently fuzzy, so we only attach a profile
// when name (and ideally employer) line up. Low confidence → no signal, never a wrong one.
// A GITHUB_TOKEN lifts the rate limit sharply (recommended) but isn't required.
import { request } from '../http.js';
import { getSettings } from '../settings.js';

const API = 'https://api.github.com';

const norm = (s) => String(s || '').trim().toLowerCase();
const tokens = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function headers() {
  const token = getSettings().github?.apiKey;
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'candidate-finder', // GitHub requires a UA
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Enrich one candidate with GitHub evidence, or return null if we can't confidently match them.
 * @returns {Promise<null | {matched:true, confidence:string, url, login, name, company,
 *   publicRepos:number, followers:number, stars:number, topLanguages:string[]}>}
 */
export async function enrichGithub(candidate, log) {
  if (!getSettings().github?.enrich) return null; // feature off
  const name = candidate.fullName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();
  if (!name) return null;

  try {
    const q = encodeURIComponent(`${name} type:user`);
    const search = await request(`${API}/search/users?q=${q}&per_page=5`, { headers: headers(), retries: 1, log });
    const items = Array.isArray(search.items) ? search.items : [];
    if (!items.length) return null;

    // Score each candidate login on name + employer overlap; take the best if it clears the bar.
    let best = null;
    for (const item of items.slice(0, 5)) {
      const user = await request(`${API}/users/${item.login}`, { headers: headers(), retries: 1, log }).catch(() => null);
      if (!user) continue;
      const conf = confidence(candidate, name, user);
      if (!best || conf.score > best.conf.score) best = { user, conf };
    }
    if (!best || best.conf.score < 2) return null; // not confident enough → no signal

    const repos = await repoStats(best.user.login, log);
    return {
      matched: true,
      confidence: best.conf.label,
      url: best.user.html_url,
      login: best.user.login,
      name: best.user.name || '',
      company: best.user.company || '',
      publicRepos: best.user.public_repos || 0,
      followers: best.user.followers || 0,
      stars: repos.stars,
      topLanguages: repos.languages,
    };
  } catch (err) {
    log?.warn?.('github enrich failed', { candidate: name, error: err.message });
    return null;
  }
}

/** Confidence that a GitHub user is this candidate. */
function confidence(candidate, name, user) {
  let score = 0;
  const nameToks = new Set(tokens(name));
  const ghToks = new Set(tokens(user.name || user.login));
  const overlap = [...nameToks].filter((t) => ghToks.has(t)).length;
  if (overlap >= 2) score += 2; // first + last name both present
  else if (overlap === 1) score += 1;
  // Employer match is a strong signal.
  const co = norm(candidate.company);
  if (co && norm(user.company).includes(co.split(' ')[0])) score += 2;
  const label = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { score, label };
}

/** Aggregate a user's public repos into total stars + the languages they actually use. */
async function repoStats(login, log) {
  const repos = await request(`${API}/users/${login}/repos?per_page=100&sort=pushed`, { headers: headers(), retries: 1, log }).catch(() => []);
  const list = Array.isArray(repos) ? repos : [];
  let stars = 0;
  const langCount = new Map();
  for (const r of list) {
    if (r.fork) continue; // their own work, not forks
    stars += r.stargazers_count || 0;
    if (r.language) langCount.set(r.language, (langCount.get(r.language) || 0) + 1);
  }
  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l);
  return { stars, languages };
}
