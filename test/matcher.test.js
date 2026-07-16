import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCandidates, groupByCompany, preRank } from '../src/matcher.js';
import { logger } from '../src/logger.js';

const quietLog = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quietLog[k] = () => {};

// No ANTHROPIC_API_KEY in the test env → AI scoring is off → deterministic-only, no network.
const tierMap = new Map([['stripe', 1], ['airbnb', 2]]);

const roles = [
  {
    id: 'be', title: 'Senior Backend Engineer', searchTitles: ['Senior Backend Engineer'],
    seniority: ['senior'], requiredSkills: ['Go', 'Kubernetes'], niceToHaveSkills: [],
    location: 'NYC', capacity: 1, company: { id: 'c1', name: 'Co1', tier: 1 },
  },
  {
    id: 'fe', title: 'Frontend Engineer', searchTitles: ['Frontend Engineer'],
    seniority: ['mid'], requiredSkills: ['React', 'TypeScript'], niceToHaveSkills: [],
    location: 'LA', capacity: 5, company: { id: 'c2', name: 'Co2', tier: 2 },
  },
];

test('preRank orders a wide pool best-first on deterministic signals alone (no email needed)', () => {
  const pool = [
    { fullName: 'Weak Match', title: 'Marketing Manager', company: 'Unknown Co', headline: 'brand campaigns' },
    { fullName: 'Strong Match', title: 'Senior Backend Engineer', company: 'Stripe', headline: 'Go Kubernetes microservices at scale' },
    { fullName: 'Mid Match', title: 'Frontend Engineer', company: 'Airbnb', headline: 'React TypeScript' },
  ];
  const ranked = preRank(pool, roles, tierMap);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].candidate.fullName, 'Strong Match'); // best deterministic score first
  assert.ok(ranked[0].det.overall >= ranked[2].det.overall);
});

test('matches candidates to their best-fit role', async () => {
  const candidates = [
    { fullName: 'Backend Person', title: 'Senior Backend Engineer', seniority: 'senior', headline: 'Go, Kubernetes', company: 'Stripe', email: 'be@x.com', linkedinUrl: 'u1' },
    { fullName: 'Frontend Person', title: 'Frontend Engineer', seniority: 'mid', headline: 'React, TypeScript', company: 'Airbnb', email: 'fe@x.com', linkedinUrl: 'u2' },
  ];
  const { matches, aiUsed } = await matchCandidates(candidates, roles, tierMap, quietLog);
  assert.equal(aiUsed, false); // no key
  assert.equal(matches.length, 2);
  const byName = Object.fromEntries(matches.map((m) => [m.candidate.fullName, m.role.id]));
  assert.equal(byName['Backend Person'], 'be');
  assert.equal(byName['Frontend Person'], 'fe');
});

test('respects role capacity — extra qualified candidates overflow to unmatched', async () => {
  const candidates = [
    { fullName: 'BE One', title: 'Senior Backend Engineer', seniority: 'senior', headline: 'Go, Kubernetes', company: 'Stripe', email: 'a@x.com', linkedinUrl: 'a' },
    { fullName: 'BE Two', title: 'Senior Backend Engineer', seniority: 'senior', headline: 'Go, Kubernetes', company: 'Google', email: 'b@x.com', linkedinUrl: 'b' },
  ];
  const { matches, unmatched } = await matchCandidates(candidates, roles, tierMap, quietLog);
  // 'be' role has capacity 1, so only one of the two backend folks is matched.
  assert.equal(matches.filter((m) => m.role.id === 'be').length, 1);
  assert.ok(unmatched.length >= 1);
});

test('below-threshold candidates are not matched', async () => {
  const candidates = [
    { fullName: 'Weak Fit', title: 'Junior Designer', seniority: 'junior', headline: 'Photoshop', company: 'Nowhere', email: 'w@x.com', linkedinUrl: 'w' },
  ];
  const { matches } = await matchCandidates(candidates, roles, tierMap, quietLog);
  assert.equal(matches.length, 0);
});

test('groupByCompany buckets matches by company', () => {
  const matches = [
    { role: { company: { id: 'c1', name: 'Co1' } }, candidate: {} },
    { role: { company: { id: 'c1', name: 'Co1' } }, candidate: {} },
    { role: { company: { id: 'c2', name: 'Co2' } }, candidate: {} },
  ];
  const groups = groupByCompany(matches);
  assert.equal(groups.length, 2);
});
