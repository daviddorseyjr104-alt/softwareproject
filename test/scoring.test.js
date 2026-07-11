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

test('composite: reweights to deterministic when AI is null', () => {
  const det = { overall: 72, seniority: 90, skills: 80, pedigree: 60 };
  const noAi = compositeScore(det, null);
  assert.equal(noAi.usedAi, false);
  assert.equal(noAi.overall, 72);

  const withAi = compositeScore(det, 100);
  assert.equal(withAi.usedAi, true);
  assert.ok(withAi.overall > noAi.overall); // a high AI score should pull the composite up
});

test('deterministicScore blends the three signals into 0-100', () => {
  const cand = { title: 'Senior Frontend Engineer', headline: 'React, TypeScript, GraphQL', company: 'Airbnb' };
  const map = new Map([['airbnb', 2]]);
  const d = deterministicScore(cand, role, map);
  assert.ok(d.overall >= 0 && d.overall <= 100);
  assert.ok(d.overall > 70); // strong candidate
});
