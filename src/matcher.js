// Matches candidates to their best-fit role/company across the whole pool.
//
// Strategy (bounds AI cost to ~1 call per candidate):
//   1. Cheap deterministic score of each candidate against EVERY role.
//   2. Pick each candidate's best role by that score.
//   3. Run the AI fit score once, for that best pairing only.
//   4. Final composite decides accept/reject vs the threshold.
//   5. Assign accepted candidates to their role, respecting per-role capacity
//      (best scores win the seats; ties break toward the higher-tier company).
import { getSettings } from './settings.js';
import { mapLimit } from './http.js';
import { deterministicScore, compositeScore } from './scoring/score.js';
import { aiFitScore, aiEnabled } from './scoring/aiFit.js';

/**
 * @param {Array} candidates  enriched candidates (with email)
 * @param {Array} roles       flat role list from loadPool()
 * @param {Map}   tierMap      company-tier lookup
 * @param {object} log
 * @returns {Promise<{matches:Array, unmatched:Array, aiUsed:boolean}>}
 */
export async function matchCandidates(candidates, roles, tierMap, log) {
  const aiUsed = aiEnabled();

  // Steps 1-3: score each candidate, find best role, add AI fit for that pairing.
  const scored = await mapLimit(candidates, 5, async (candidate) => {
    // Deterministic score vs every role.
    let best = null;
    for (const role of roles) {
      const det = deterministicScore(candidate, role, tierMap);
      if (!best || det.overall > best.det.overall) best = { role, det };
    }
    if (!best) return null;

    // One AI call, for the best pairing only.
    const ai = await aiFitScore(candidate, best.role, log);
    const composite = compositeScore(best.det, ai?.fitScore ?? null);

    return {
      candidate,
      role: best.role,
      score: composite.overall,
      usedAi: composite.usedAi,
      breakdown: {
        seniority: best.det.seniority,
        skills: best.det.skills,
        pedigree: best.det.pedigree,
        aiFit: ai?.fitScore ?? null,
        pedigreeTier: best.det.pedigreeTier,
        matchedSkills: best.det.matchedSkills,
        missingSkills: best.det.missingSkills,
      },
      ai: ai ? { reasoning: ai.reasoning, strengths: ai.strengths, concerns: ai.concerns, recommend: ai.recommend } : null,
    };
  });

  const results = scored.filter(Boolean);

  // Step 4: threshold.
  const threshold = getSettings().scoring.threshold;
  const passed = results.filter((r) => r.score >= threshold);
  const belowThreshold = results.filter((r) => r.score < threshold);

  // Step 5: capacity per role. Best scores claim seats first; ties → higher-tier company (lower tier number).
  passed.sort((a, b) => b.score - a.score || (a.role.company.tier - b.role.company.tier));

  const filled = new Map(); // roleId -> count
  const matches = [];
  const overflow = [];
  for (const r of passed) {
    const used = filled.get(r.role.id) || 0;
    if (used < r.role.capacity) {
      filled.set(r.role.id, used + 1);
      matches.push(r);
    } else {
      overflow.push(r); // qualified but the role is full
    }
  }

  log?.info('matching done', {
    candidates: candidates.length,
    matched: matches.length,
    belowThreshold: belowThreshold.length,
    overCapacity: overflow.length,
    aiUsed,
    threshold,
  });

  return { matches, unmatched: [...belowThreshold, ...overflow], aiUsed };
}

/** Group matches by company for campaign creation. */
export function groupByCompany(matches) {
  const byCompany = new Map();
  for (const m of matches) {
    const key = m.role.company.id;
    if (!byCompany.has(key)) byCompany.set(key, { company: m.role.company, matches: [] });
    byCompany.get(key).matches.push(m);
  }
  return [...byCompany.values()];
}
