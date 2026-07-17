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
    // Deterministic score vs EVERY role, kept and ranked. The ranking is what lets an
    // overflow candidate fall back to their next-best role in step 5 instead of being dropped.
    const ranked = roles
      .map((role) => ({ role, det: deterministicScore(candidate, role, tierMap) }))
      .sort((a, b) => b.det.overall - a.det.overall);
    const best = ranked[0];
    if (!best) return null;

    // One AI call, for the best pairing only. `aiUsed` distinguishes "AI is off for this run"
    // from "AI is on but this one call failed" — the two must score differently, see score.js.
    const ai = await aiFitScore(candidate, best.role, log);
    const composite = compositeScore(best.det, ai?.fitScore ?? null, { aiAvailable: aiUsed });

    return {
      candidate,
      ranked, // every role, best-first — used to reassign if the top role fills up
      role: best.role,
      score: composite.overall,
      usedAi: composite.usedAi,
      aiFailed: composite.aiFailed,
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
  let overflow = [];
  for (const r of passed) {
    const used = filled.get(r.role.id) || 0;
    if (used < r.role.capacity) {
      filled.set(r.role.id, used + 1);
      matches.push(r);
    } else {
      overflow.push(r); // qualified, but their best-fit role is full
    }
  }

  // Step 5b: reassign overflow to their next-best role that still has a seat.
  //
  // Locking each candidate to one pre-computed best role meant a full role DISCARDED them, even
  // when a role they scored just as well on sat empty: two roles at capacity 1, two candidates
  // both topping role A, and role B never gets filled — one hire from two seats and two
  // qualified people. Which candidate got stranded came down to Apollo's return order.
  const reassigned = [];
  const stillOver = [];
  for (const r of overflow) {
    const alt = (r.ranked || []).find((x) =>
      x.role.id !== r.role.id && (filled.get(x.role.id) || 0) < x.role.capacity);
    if (!alt) { stillOver.push(r); continue; }

    // Re-score against the NEW role. The AI judged them against their original role, so its
    // verdict doesn't transfer — re-run it when it's on, and keep the scale consistent with
    // everyone else. This costs at most one extra call per overflow candidate.
    const altAi = await aiFitScore(r.candidate, alt.role, log);
    const composite = compositeScore(alt.det, altAi?.fitScore ?? null, { aiAvailable: aiUsed });
    if (composite.overall < threshold) { stillOver.push(r); continue; }

    filled.set(alt.role.id, (filled.get(alt.role.id) || 0) + 1);
    reassigned.push({
      ...r,
      role: alt.role,
      score: composite.overall,
      usedAi: composite.usedAi,
      aiFailed: composite.aiFailed,
      reassigned: true, // not their top role — their top role was full
      breakdown: {
        seniority: alt.det.seniority,
        skills: alt.det.skills,
        pedigree: alt.det.pedigree,
        aiFit: altAi?.fitScore ?? null,
        pedigreeTier: alt.det.pedigreeTier,
        matchedSkills: alt.det.matchedSkills,
        missingSkills: alt.det.missingSkills,
      },
      ai: altAi
        ? { reasoning: altAi.reasoning, strengths: altAi.strengths, concerns: altAi.concerns, recommend: altAi.recommend }
        : null,
    });
  }
  matches.push(...reassigned);
  overflow = stillOver;

  log?.info('matching done', {
    candidates: candidates.length,
    matched: matches.length,
    reassigned: reassigned.length,
    belowThreshold: belowThreshold.length,
    overCapacity: overflow.length,
    aiUsed,
    threshold,
  });

  return { matches, unmatched: [...belowThreshold, ...overflow], aiUsed };
}

/**
 * Cheap deterministic pre-rank of a WIDE candidate pool BEFORE enrichment — so we spend
 * SalesQL credits only on the most promising people, not on everyone Apollo returned.
 * Uses title/headline/company only (no email needed). Returns candidates sorted best-first.
 * @returns {Array<{candidate:object, det:object}>}
 */
export function preRank(candidates, roles, tierMap) {
  return candidates
    .map((candidate) => {
      let best = null;
      for (const role of roles) {
        const det = deterministicScore(candidate, role, tierMap);
        if (!best || det.overall > best.overall) best = det;
      }
      return { candidate, det: best };
    })
    .filter((x) => x.det)
    .sort((a, b) => b.det.overall - a.det.overall);
}

/**
 * Group matches into one bucket per (company, role) for campaign creation.
 *
 * Grouping by company alone is wrong whenever a company has more than one open role: every
 * candidate in the bucket inherits the FIRST match's role title and salary, so a backend
 * engineer gets pitched the frontend job at the frontend salary. Roles are per-company in the
 * pool schema, so the key must include the role.
 */
export function groupByCompanyRole(matches) {
  const byKey = new Map();
  for (const m of matches) {
    // JSON-encode the pair: string concatenation would let ids containing the separator
    // collide two distinct (company, role) buckets into one.
    const key = JSON.stringify([m.role.company.id, m.role.id]);
    if (!byKey.has(key)) byKey.set(key, { company: m.role.company, role: m.role, matches: [] });
    byKey.get(key).matches.push(m);
  }
  return [...byKey.values()];
}
