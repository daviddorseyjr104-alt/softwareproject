// Seniority + experience score (0-100), deterministic from Apollo-provided fields.
// Rewards a candidate whose seniority/level matches (or exceeds) what the role wants.

const SENIORITY_RANK = {
  intern: 0,
  entry: 1,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  manager: 4,
  head: 5,
  director: 5,
  vp: 6,
  partner: 6,
  owner: 7,
  founder: 7,
  c_suite: 7,
};

function rankOf(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().replace(/[^a-z_]/g, '');
  return SENIORITY_RANK[key] ?? null;
}

/** Infer a seniority rank from a candidate's title text when Apollo gives no explicit field. */
function rankFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(cto|ceo|chief|vp|vice president)\b/.test(t)) return 6;
  if (/\b(director|head of)\b/.test(t)) return 5;
  if (/\b(principal|staff|lead|manager)\b/.test(t)) return 4;
  // `\bsenior|sr\.?\b` had no \b before "sr" (alternation binds looser than the anchors), so any
  // title merely ENDING in those letters — "MSR", "Advisr" — was read as senior. Anchor both
  // alternatives. A trailing "." doesn't need matching: \b already ends the token at it.
  if (/\b(senior|sr)\b/.test(t)) return 3;
  if (/\b(junior|jr|associate|entry)\b/.test(t)) return 1;
  if (/\bintern\b/.test(t)) return 0;
  return 2; // default: mid
}

/**
 * @param {object} candidate  has `title`, optional `seniority`
 * @param {object} role       has `seniority` (array of desired levels)
 * @returns {number} 0-100
 */
export function seniorityScore(candidate, role) {
  const candidateRank = rankOf(candidate.seniority) ?? rankFromTitle(candidate.title);

  const wanted = (role.seniority || []).map(rankOf).filter((r) => r != null);
  if (wanted.length === 0) return 70; // role didn't specify — neutral-positive

  const target = Math.max(...wanted);
  const diff = candidateRank - target;

  // Exact match is best; being one level over is fine; under-qualified drops fast.
  if (diff === 0) return 100;
  if (diff === 1) return 90;
  if (diff >= 2) return 75; // over-qualified — still valuable but may be a flight risk
  if (diff === -1) return 55;
  return 30; // two or more levels under
}
