// AI fit score (0-100) — Claude reads a candidate's profile against a role and judges overall fit.
// Uses structured outputs so the response is guaranteed to match our schema.
//
// Model: claude-opus-4-8 (per project default). Adaptive thinking + low effort keeps
// per-candidate scoring affordable. Degrades gracefully: if no ANTHROPIC_API_KEY is set,
// or the API errors/refuses, returns null and the composite reweights to deterministic signals.
import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../settings.js';

const MODEL = 'claude-opus-4-8';

// Structured-output schema. Structured outputs ignore numeric bounds, so we clamp in code.
const FIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fitScore: { type: 'integer', description: '0-100 overall fit for THIS role' },
    reasoning: { type: 'string', description: 'One or two sentences justifying the score' },
    strengths: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    recommend: { type: 'boolean', description: 'Would you shortlist this person for this role?' },
  },
  required: ['fitScore', 'reasoning', 'strengths', 'concerns', 'recommend'],
};

// Cache the SDK client, but re-create it if the key changes (e.g. saved via the admin UI).
let client = null;
let clientKey = null;
function getClient() {
  const apiKey = getSettings().ai.apiKey;
  if (!apiKey) return null; // no key → skip AI entirely
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export function aiEnabled() {
  return Boolean(getSettings().ai.apiKey);
}

/**
 * Score one candidate against one role.
 * @returns {Promise<{fitScore:number, reasoning:string, strengths:string[], concerns:string[], recommend:boolean} | null>}
 */
export async function aiFitScore(candidate, role, log) {
  const anthropic = getClient();
  if (!anthropic) return null;

  const prompt = buildPrompt(candidate, role);

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      // Adaptive thinking shares this budget with the JSON output; 1024 could truncate
      // the structured result (→ JSON.parse throws → candidate silently loses its AI score).
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: getSettings().ai.effort, // 'low' by default — scoring is simple, keep cost down
        format: { type: 'json_schema', schema: FIT_SCHEMA },
      },
      system:
        'You are a rigorous technical recruiter. Judge how well a candidate fits a specific ' +
        'software engineering role based only on the evidence given. Be honest and calibrated: ' +
        'reserve scores above 80 for genuinely strong matches. If evidence is thin, say so in your ' +
        'concerns and score conservatively.',
      messages: [{ role: 'user', content: prompt }],
    });

    if (res.stop_reason === 'refusal') {
      log?.warn('ai fit refused', { candidate: candidate.fullName });
      return null;
    }

    if (res.stop_reason === 'max_tokens') {
      log?.warn('ai fit truncated (raise max_tokens)', { candidate: candidate.fullName });
      return null;
    }

    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    parsed.fitScore = clamp(parsed.fitScore);
    return parsed;
  } catch (err) {
    log?.warn('ai fit error', { candidate: candidate.fullName, error: err.message });
    return null; // fall back to deterministic scoring
  }
}

function buildPrompt(candidate, role) {
  return [
    'ROLE',
    `Title: ${role.title}`,
    `Company: ${role.company?.name || ''}`,
    `Location: ${role.location || ''}`,
    `Required skills: ${(role.requiredSkills || []).join(', ') || 'n/a'}`,
    `Nice-to-have skills: ${(role.niceToHaveSkills || []).join(', ') || 'n/a'}`,
    `Desired seniority: ${(role.seniority || []).join(', ') || 'n/a'}`,
    '',
    'CANDIDATE',
    `Name: ${candidate.fullName || ''}`,
    `Current title: ${candidate.title || ''}`,
    `Current company: ${candidate.company || ''}`,
    `Location: ${candidate.location || ''}`,
    `Headline: ${candidate.headline || 'n/a'}`,
    `LinkedIn: ${candidate.linkedinUrl || 'n/a'}`,
    githubBlock(candidate.github),
    '',
    'Judge overall fit for THIS role and return the structured verdict. Weight real, verifiable',
    'engineering evidence (GitHub activity, languages actually shipped, stars) above self-reported',
    'titles when both are present.',
  ].join('\n');
}

function githubBlock(gh) {
  if (!gh || !gh.matched) return 'GitHub: not found (no verifiable code signal)';
  const langs = (gh.topLanguages || []).join(', ') || 'n/a';
  return `GitHub (${gh.confidence} confidence): ${gh.url} — ${gh.publicRepos} public repos, ` +
    `${gh.stars} stars, ${gh.followers} followers; ships in: ${langs}`;
}

function clamp(n) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}
