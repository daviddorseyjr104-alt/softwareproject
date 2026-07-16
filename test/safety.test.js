import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

// Isolated data dir BEFORE importing (modules read bootConfig.dataDir at load).
process.env.DATA_DIR = join(os.tmpdir(), 'cf-safety-' + Math.random().toString(36).slice(2));

const supp = await import('../src/suppression.js');
const contacts = await import('../src/contacts.js');
const { estimateCost, DEFAULT_PRICES } = await import('../src/cost.js');

test('suppression: an email with no address is always suppressed', () => {
  assert.equal(supp.isSuppressed(''), true);
  assert.equal(supp.isSuppressed(null), true);
});

test('suppression: exact email match blocks; unrelated passes', () => {
  supp.suppress('Nope@Example.com');
  assert.equal(supp.isSuppressed('nope@example.com'), true); // case-insensitive
  assert.equal(supp.isSuppressed('yes@example.com'), false);
});

test('suppression: whole-domain block catches every address on it', () => {
  supp.suppress('competitor.com');
  assert.equal(supp.isSuppressed('anyone@competitor.com'), true);
  assert.equal(supp.isSuppressed('someone.else@competitor.com'), true);
});

test('suppression: unsuppress removes an entry', () => {
  supp.suppress('temp@x.com');
  assert.equal(supp.isSuppressed('temp@x.com'), true);
  supp.unsuppress('temp@x.com');
  assert.equal(supp.isSuppressed('temp@x.com'), false);
});

test('suppression: survives a reload from disk', () => {
  supp.suppress('persist@x.com');
  supp._reload();
  assert.equal(supp.isSuppressed('persist@x.com'), true);
});

test('contacts: never-contacted returns null age; recording sets it to 0 days', () => {
  assert.equal(contacts.lastContactAgeDays('new@x.com'), null);
  contacts.recordContacts([{ email: 'New@X.com', company: 'Acme', role: 'Eng', campaignId: 'c1' }]);
  assert.equal(contacts.lastContactAgeDays('new@x.com'), 0);
  assert.equal(contacts.recentlyContacted('new@x.com', 7), true);
  assert.equal(contacts.recentlyContacted('new@x.com', 0), false);
});

test('contacts: history is append-only and distinct-counted', () => {
  const before = contacts.contactCount();
  contacts.recordContacts([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'a@x.com' }]);
  assert.equal(contacts.contactCount(), before + 2); // a counted once
  const recent = contacts.recentContacts(3);
  assert.ok(recent.length >= 1);
});

test('cost: estimates scale with counts and sum correctly', () => {
  const c = estimateCost({ discovered: 10, enriched: 8, aiUsed: true });
  assert.equal(c.apollo, round(10 * DEFAULT_PRICES.apolloPerDiscovered));
  assert.equal(c.salesql, round(10 * DEFAULT_PRICES.salesqlPerLookup));
  assert.equal(c.anthropic, round(8 * DEFAULT_PRICES.anthropicPerScore));
  assert.equal(c.total, round(c.apollo + c.salesql + c.anthropic));
});

test('cost: AI off means zero Anthropic cost', () => {
  const c = estimateCost({ discovered: 5, enriched: 4, aiUsed: false });
  assert.equal(c.anthropic, 0);
});

function round(n) { return Math.round(n * 100) / 100; }
