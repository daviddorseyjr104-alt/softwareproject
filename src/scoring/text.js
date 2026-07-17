// Shared text matching for the deterministic scorers.
//
// Extracted from skills.js so pedigree.js can reuse it. Pedigree used a bare
// `company.includes(fragment)`, which handed tier-1 scores to any employer whose name merely
// contained a listed one — "Metabase" matched "meta", "Applebees" matched "apple". One
// implementation, one set of boundary rules, one place to fix.

/**
 * Whole-word-ish match, so "R" doesn't match "React", "Go" doesn't match "Google", and
 * "meta" doesn't match "Metabase". Boundaries respect symbols common in tech and company
 * names (c++, node.js, c#).
 *
 * @param {string} text   haystack (already lowercased or not — matching is case-insensitive)
 * @param {string} term   needle
 */
export function mentions(text, term) {
  const s = String(term || '').toLowerCase().trim();
  if (!s || !text) return false;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#]|$)`, 'i').test(String(text));
}
