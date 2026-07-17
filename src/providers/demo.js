// Demo providers — deterministic fakes that let the ENTIRE pipeline run with no API keys,
// no credits, and no network. Used by `npm run demo` and as a template for tests.
//
// Enabled at runtime by DEMO=true (see server.js), which swaps these in for the real providers.

// Deterministic pools of fake software engineers keyed loosely by what the search asks for,
// with varied seniority, employers (some tier-1), and skill-bearing headlines so the scorer
// and matcher have something real to chew on.
const BACKEND = [
  { firstName: 'Jordan', lastName: 'Ellis', title: 'Senior Backend Engineer', company: 'Stripe', seniority: 'senior', headline: 'Senior Backend Engineer — Go, Kubernetes, PostgreSQL, AWS, microservices' },
  { firstName: 'Priya', lastName: 'Nair', title: 'Backend Engineer', company: 'Datadog', seniority: 'mid', headline: 'Backend Engineer — Go, gRPC, Kafka, AWS' },
  { firstName: 'Marcus', lastName: 'Reed', title: 'Staff Software Engineer', company: 'Google', seniority: 'lead', headline: 'Staff Engineer — distributed systems, Kubernetes, Go, Terraform' },
  { firstName: 'Chen', lastName: 'Wu', title: 'Software Engineer', company: 'Acme Corp', seniority: 'junior', headline: 'Software Engineer — Python, Django, some AWS' },
];
const FRONTEND = [
  { firstName: 'Sofia', lastName: 'Alvarez', title: 'Senior Frontend Engineer', company: 'Airbnb', seniority: 'senior', headline: 'Senior Frontend Engineer — React, TypeScript, Next.js, GraphQL' },
  { firstName: 'Liam', lastName: "O'Brien", title: 'Frontend Engineer', company: 'Shopify', seniority: 'mid', headline: 'Frontend Engineer — React, TypeScript, CSS, Node.js' },
  { firstName: 'Ava', lastName: 'Rossi', title: 'React Developer', company: 'Local Studio', seniority: 'junior', headline: 'React Developer — React, JavaScript, HTML/CSS' },
];

function poolFor(titles) {
  const t = (titles || []).join(' ').toLowerCase();
  if (t.includes('front') || t.includes('react')) return FRONTEND;
  return BACKEND;
}

export const demoProviders = {
  async discoverCandidates({ titles, location, limit }, log) {
    const src = poolFor(titles);
    const people = src.slice(0, Math.max(1, Math.min(limit ?? 25, src.length))).map((p, i) => ({
      ...p,
      fullName: `${p.firstName} ${p.lastName}`,
      linkedinUrl: `https://www.linkedin.com/in/demo-${p.firstName.toLowerCase()}-${i}`,
      location: location || 'Remote',
    }));
    log.info('[DEMO] discovered candidates', { found: people.length, titles });
    return people;
  },

  async enrichCandidates(candidates, log) {
    // Simulate ~80% hit rate on personal emails.
    const enriched = candidates
      .map((c, i) => (i % 5 === 4 ? null : { ...c, email: fakeEmail(c), emailType: 'personal' }))
      .filter(Boolean);
    log.info('[DEMO] enriched', { input: candidates.length, withEmail: enriched.length });
    return enriched;
  },

  // Deterministic fake GitHub profile so DEMO shows real-looking engineering signal.
  async enrichGithub(candidate, log) {
    const langs = (candidate.headline || '').match(/\b(Go|Python|React|TypeScript|JavaScript|Kubernetes|Java|Rust|Node\.js|GraphQL|Terraform)\b/g) || [];
    if (!langs.length) return null; // no signal → no match (mirrors the real provider)
    const seed = (candidate.firstName || 'x').charCodeAt(0);
    const gh = {
      matched: true,
      confidence: seed % 3 === 0 ? 'high' : 'medium',
      url: `https://github.com/demo-${(candidate.firstName || 'dev').toLowerCase()}`,
      login: `demo-${(candidate.firstName || 'dev').toLowerCase()}`,
      name: candidate.fullName || '',
      company: candidate.company || '',
      publicRepos: 8 + (seed % 40),
      followers: 12 + (seed % 300),
      stars: 30 + (seed % 900),
      topLanguages: [...new Set(langs)].slice(0, 5),
    };
    log.info('[DEMO] github matched', { login: gh.login, langs: gh.topLanguages });
    return gh;
  },

  // Mirrors the real provider: a company with two open roles gets one campaign per role, so the
  // id must include the role too or the demo would silently collapse them into one.
  async createCampaign(companyName, log, roleTitle = '') {
    const id = `demo-campaign-${slug(companyName)}${roleTitle ? '-' + slug(roleTitle) : ''}`;
    const name = roleTitle ? `${companyName} – ${roleTitle} – Candidate Outreach` : `${companyName} – Candidate Outreach`;
    log.info('[DEMO] campaign created', { id, name });
    return { id, name };
  },

  async addLeads(campaignId, candidates, _form, log) {
    log.info('[DEMO] leads added', { campaignId, added: candidates.length });
    return { added: candidates.length, failed: 0 };
  },

  async activateCampaign(campaignId, log) {
    log.info('[DEMO] campaign activated', { campaignId });
    return true;
  },
};

function fakeEmail(c) {
  return `${c.firstName}.${c.lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com';
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
