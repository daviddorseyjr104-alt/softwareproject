import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seniorityScore } from '../src/scoring/seniority.js';
import { skillsScore } from '../src/scoring/skills.js';
import { pedigreeScore } from '../src/scoring/pedigree.js';
import { deterministicScore, compositeScore } from '../src/scoring/score.js';

const role = {
  seniority: ['senior'],
  requiredSkills: ['React', 'TypeScript', 'GraphQL'],
  niceToHaveSkills: ['Node.js'],
};

test('seniority: exact match scores highest, under-qualified drops', () => {
  assert.equal(seniorityScore({ title: 'Senior Engineer', seniority: 'senior' }, role), 100);
  assert.ok(seniorityScore({ title: 'Junior Engineer', seniority: 'junior' }, role) < 60);
});

test('seniority: infers level from title when no explicit field', () => {
  assert.equal(seniorityScore({ title: 'Senior Frontend Engineer' }, role), 100);
});

test('seniority: title matching respects word boundaries', () => {
  const role = { seniority: ['senior'] };
  assert.equal(seniorityScore({ title: 'Sr. Backend Engineer' }, role), 100, '"Sr." is senior');
  assert.equal(seniorityScore({ title: 'Senior Backend Engineer' }, role), 100);
  // "MSR Engineer" ends in the letters "sr" but is not senior — the old regex said it was.
  assert.ok(seniorityScore({ title: 'MSR Engineer' }, role) < 100, '"MSR" must not read as senior');
  assert.ok(seniorityScore({ title: 'Advisr Analyst' }, role) < 100);
});

test('skills: full required match scores high, partial lower', () => {
  const full = skillsScore({ headline: 'React, TypeScript, GraphQL, Node.js' }, role);
  assert.ok(full.score >= 90);
  assert.equal(full.missing.length, 0);

  const partial = skillsScore({ headline: 'React only' }, role);
  assert.ok(partial.score < full.score);
  assert.ok(partial.missing.includes('TypeScript'));
});

test('skills: word boundaries avoid false positives (Go != Google)', () => {
  const r = { requiredSkills: ['Go'], niceToHaveSkills: [] };
  assert.equal(skillsScore({ headline: 'Works at Google', company: 'Google' }, r).matched.length, 0);
  assert.equal(skillsScore({ headline: 'Go and Kubernetes' }, r).matched.length, 1);
});

test('pedigree: tier-1 employer scores highest, unknown neutral', () => {
  const map = new Map([['stripe', 1], ['shopify', 2]]);
  assert.equal(pedigreeScore({ company: 'Stripe' }, map).score, 100);
  assert.equal(pedigreeScore({ company: 'Shopify' }, map).score, 85);
  assert.ok(pedigreeScore({ company: 'Nowhere Inc' }, map).score < 70);
});

// Substring matching used to hand tier-1 pedigree to any company merely CONTAINING a listed
// name — worth ~+11 on the deterministic overall, enough to clear the accept threshold.
test('pedigree: matches whole words, not substrings (Metabase is not Meta)', () => {
  const map = new Map([['meta', 1], ['apple', 1], ['intel', 3]]);
  assert.equal(pedigreeScore({ company: 'Meta' }, map).score, 100, 'the real company still matches');
  assert.equal(pedigreeScore({ company: 'Meta Platforms' }, map).score, 100, 'multi-word names still match');
  for (const impostor of ['Metabase', 'Applebees', 'Intellect Design']) {
    const r = pedigreeScore({ company: impostor }, map);
    assert.equal(r.tier, null, `${impostor} must not inherit a tier by substring`);
    assert.ok(r.score < 70, `${impostor} scored ${r.score} — should be the not-on-list default`);
  }
});

test('composite: reweights to deterministic when AI is null', () => {
  const det = { overall: 72, seniority: 90, skills: 80, pedigree: 60 };
  const noAi = compositeScore(det, null);
  assert.equal(noAi.usedAi, false);
  assert.equal(noAi.overall, 72);

  const withAi = compositeScore(det, 100);
  assert.equal(withAi.usedAi, true);
  assert.ok(withAi.overall > noAi.overall); // a high AI score should pull the composite up
});

// An Anthropic blip used to PROMOTE the candidate it failed on: null fell back to the
// reweighted deterministic score (72), which outranks the honest 4-weight score of a peer the
// AI actually judged — and then claimed a capacity seat. A failure must never be a promotion.
test('composite: an AI call that FAILS mid-run does not outrank an AI-rejected peer', () => {
  const det = { overall: 72, seniority: 90, skills: 80, pedigree: 60 };

  const aiRejected = compositeScore(det, 20, { aiAvailable: true });
  const aiErrored = compositeScore(det, null, { aiAvailable: true });

  assert.equal(aiErrored.aiFailed, true, 'a failed call must be flagged, not silently absorbed');
  assert.equal(aiErrored.usedAi, false, 'no AI verdict was actually used');
  assert.ok(
    aiErrored.overall < det.overall,
    `an AI error scored ${aiErrored.overall} — it must not inherit the deterministic 72`,
  );
  assert.ok(aiErrored.overall > aiRejected.overall, 'a neutral prior should still beat an explicit rejection');

  // The distinction that matters: AI off for everyone is fair reweighting; AI on but broken
  // for one candidate is a scale mismatch and must be scored on the shared 4-weight scale.
  const aiDisabled = compositeScore(det, null, { aiAvailable: false });
  assert.equal(aiDisabled.overall, 72);
  assert.notEqual(aiErrored.overall, aiDisabled.overall);
});

test('deterministicScore blends the three signals into 0-100', () => {
  const cand = { title: 'Senior Frontend Engineer', headline: 'React, TypeScript, GraphQL', company: 'Airbnb' };
  const map = new Map([['airbnb', 2]]);
  const d = deterministicScore(cand, role, map);
  assert.ok(d.overall >= 0 && d.overall <= 100);
  assert.ok(d.overall > 70); // strong candidate
});
