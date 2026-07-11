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

/**
 * Final composite including the AI fit score (or reweighted deterministic if AI is null).
 * @param {object} det   result of deterministicScore
 * @param {number|null} aiFit  0-100 AI fit, or null when AI is unavailable
 */
export function compositeScore(det, aiFit) {
  const w = getSettings().scoring.weights;
  if (aiFit == null) {
    return { overall: det.overall, usedAi: false }; // deterministic-only (already renormalized)
  }
  const total = w.aiFit + w.seniority + w.skills + w.pedigree || 1;
  const overall = Math.round(
    (aiFit * w.aiFit +
      det.seniority * w.seniority +
      det.skills * w.skills +
      det.pedigree * w.pedigree) /
      total,
  );
  return { overall, usedAi: true };
}
