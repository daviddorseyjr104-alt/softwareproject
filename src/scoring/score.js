// Composite scorer: blends the four signals into one 0-100 fit score for a candidate↔role pair.
import { getSettings } from '../settings.js';
import { seniorityScore } from './seniority.js';
import { skillsScore } from './skills.js';
import { pedigreeScore } from './pedigree.js';

/**
 * Deterministic sub-scores only (no AI). Cheap — safe to run candidate × every role.
 * @returns {{overall:number, seniority:number, skills:number, pedigree:number, matchedSkills:string[], missingSkills:string[], pedigreeTier:number|null}}
 */
export function deterministicScore(candidate, role, tierMap) {
  const sen = seniorityScore(candidate, role);
  const sk = skillsScore(candidate, role);
  const ped = pedigreeScore(candidate, tierMap);

  // Weight without AI: renormalize the three deterministic weights.
  const w = getSettings().scoring.weights;
  const total = w.seniority + w.skills + w.pedigree || 1;
  const overall = Math.round(
    (sen * w.seniority + sk.score * w.skills + ped.score * w.pedigree) / total,
  );

  return {
    overall,
    seniority: sen,
    skills: sk.score,
    pedigree: ped.score,
    matchedSkills: sk.matched,
    missingSkills: sk.missing,
    pedigreeTier: ped.tier,
  };
}

/** Score used when the AI was supposed to weigh in but the call failed — a neutral prior. */
export const AI_FALLBACK_SCORE = 50;

/**
 * Final composite including the AI fit score.
 *
 * There are two different reasons `aiFit` can be null, and they must NOT be handled the same way:
 *
 *  1. AI is switched off for the whole run (no ANTHROPIC_API_KEY). Every candidate is scored
 *     without it, so reweighting the three deterministic signals is fair — everyone is compared
 *     on one scale.
 *
 *  2. AI is on, but THIS candidate's call failed (API blip, refusal, truncation). Reweighting
 *     here silently moves one candidate onto a different scale from their competitors, and it
 *     runs one way: a strong-on-paper candidate the AI would have rejected keeps their high
 *     deterministic score and outranks honestly-scored peers — then claims a capacity seat.
 *     Concretely, with det.overall 72 and threshold 60: an AI score of 20 yields 55 (rejected),
 *     but an AI *error* yielded 72 (accepted and emailed). A failure must not be a promotion.
 *     So we substitute a neutral prior on the same 4-weight scale and flag it.
 *
 * @param {object} det   result of deterministicScore
 * @param {number|null} aiFit  0-100 AI fit, or null if unavailable/failed
 * @param {object} [opts]
 * @param {boolean} [opts.aiAvailable] whether AI scoring was enabled for this run. Defaults to
 *   "a score was supplied", which is the right inference for every caller EXCEPT the one that
 *   must distinguish a failed call from a disabled feature — matcher.js passes it explicitly.
 */
export function compositeScore(det, aiFit, { aiAvailable = aiFit != null } = {}) {
  const w = getSettings().scoring.weights;

  // Case 1: AI off for everyone — reweighted deterministic, already computed.
  if (!aiAvailable) return { overall: det.overall, usedAi: false, aiFailed: false };

  // Case 2: AI on but this call failed — neutral prior, same scale as everyone else.
  const aiFailed = aiFit == null;
  const effectiveAi = aiFailed ? AI_FALLBACK_SCORE : aiFit;

  const total = w.aiFit + w.seniority + w.skills + w.pedigree || 1;
  const overall = Math.round(
    (effectiveAi * w.aiFit +
      det.seniority * w.seniority +
      det.skills * w.skills +
      det.pedigree * w.pedigree) /
      total,
  );
  return { overall, usedAi: !aiFailed, aiFailed };
}
