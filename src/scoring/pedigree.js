// Company-pedigree score (0-100), deterministic from the tier list (data/company-tiers.json).
// Weights candidates who currently work at (or recently worked at) a strong company.
import { mentions } from './text.js';

/**
 * @param {object} candidate       has `company` (current employer name)
 * @param {Map<string,number>} tierMap  from loadCompanyTiers()
 * @returns {{score:number, tier:number|null, matchedCompany:string|null}}
 */
export function pedigreeScore(candidate, tierMap) {
  const company = String(candidate.company || '').toLowerCase();
  if (!company || !tierMap || tierMap.size === 0) {
    return { score: 60, tier: null, matchedCompany: null }; // unknown — neutral
  }

  // Find the strongest (lowest-numbered) tier whose name matches the company on WORD boundaries.
  //
  // A bare `company.includes(fragment)` handed tier-1 pedigree to any company whose name merely
  // contained a listed one as a substring: "Metabase" matched "meta", "Applebees" matched
  // "apple", "Intellect Design" matched "intel". That is +45 pedigree (100 vs 55), worth ~+11 on
  // the deterministic overall — enough to push an unrelated candidate past the accept threshold.
  let best = null;
  let matched = null;
  for (const [fragment, tier] of tierMap) {
    if (mentions(company, fragment) && (best === null || tier < best)) {
      best = tier;
      matched = fragment;
    }
  }

  if (best === null) return { score: 55, tier: null, matchedCompany: null }; // not on the list

  const byTier = { 1: 100, 2: 85, 3: 70 };
  return { score: byTier[best] ?? 60, tier: best, matchedCompany: matched };
}
