// Skills / tech-stack match score (0-100), deterministic.
//
// Apollo's people-search data rarely includes a clean skills list, so we match the role's
// required/nice-to-have skills against the text we DO have: the candidate's title, headline,
// and (when present) any skills/keywords field. This is a heuristic signal; the AI fit score
// does the deeper judgment.

function candidateText(candidate) {
  return [
    candidate.title,
    candidate.headline,
    Array.isArray(candidate.skills) ? candidate.skills.join(' ') : candidate.skills,
    candidate.summary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Whole-word-ish match so "R" doesn't match "React" and "Go" doesn't match "Google". */
function mentions(text, skill) {
  const s = String(skill).toLowerCase().trim();
  if (!s) return false;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundaries that respect symbols common in tech names (c++, node.js, c#).
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#]|$)`, 'i').test(text);
}

/**
 * @returns {{score:number, matched:string[], missing:string[]}}
 * Required skills dominate; nice-to-haves give a smaller boost.
 */
export function skillsScore(candidate, role) {
  const text = candidateText(candidate);
  const required = role.requiredSkills || [];
  const nice = role.niceToHaveSkills || [];

  if (required.length === 0 && nice.length === 0) {
    return { score: 70, matched: [], missing: [] };
  }

  const matchedRequired = required.filter((s) => mentions(text, s));
  const missing = required.filter((s) => !mentions(text, s));
  const matchedNice = nice.filter((s) => mentions(text, s));

  const requiredRatio = required.length ? matchedRequired.length / required.length : 1;
  const niceRatio = nice.length ? matchedNice.length / nice.length : 0;

  // Required skills are 80% of the weight; nice-to-haves 20%.
  const score = Math.round((requiredRatio * 0.8 + niceRatio * 0.2) * 100);
  return { score, matched: [...matchedRequired, ...matchedNice], missing };
}
