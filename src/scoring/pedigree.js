// Company-pedigree score (0-100), deterministic from the tier list (data/company-tiers.json).
// Weights candidates who currently work at (or recently worked at) a strong company.

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

  // Find the strongest (lowest-numbered) tier whose name fragment appears in the company.
  let best = null;
  let matched = null;
  for (const [fragment, tier] of tierMap) {
    if (company.includes(fragment) && (best === null || tier < best)) {
      best = tier;
      matched = fragment;
    }
  }

  if (best === null) return { score: 55, tier: null, matchedCompany: null }; // not on the list

  const byTier = { 1: 100, 2: 85, 3: 70 };
  return { score: byTier[best] ?? 60, tier: best, matchedCompany: matched };
}
