import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPool, loadCompanyTiers } from '../src/pool.js';

test('loads the example pool and flattens roles with company context', () => {
  const { companies, roles, usingExample } = loadPool();
  assert.ok(companies.length >= 1);
  assert.ok(roles.length >= 1);
  // No data/companies.json committed, so it should fall back to the example.
  assert.equal(usingExample, true);
  for (const role of roles) {
    assert.ok(role.id && role.title);
    assert.ok(role.company && role.company.name);
    assert.ok(Array.isArray(role.searchTitles) && role.searchTitles.length >= 1);
    assert.ok(Number.isFinite(role.capacity));
  }
});

test('loads company tiers as a lowercased lookup', () => {
  const { map } = loadCompanyTiers();
  assert.ok(map.size > 0);
  assert.equal(map.get('google'), 1);
});
