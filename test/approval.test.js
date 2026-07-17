import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = join(os.tmpdir(), 'cf-approval-' + Math.random().toString(36).slice(2));

const { previewSearch, previewPool, commit } = await import('../src/approval.js');
const supp = await import('../src/suppression.js');
const contacts = await import('../src/contacts.js');
const settings = await import('../src/settings.js');
const { logger } = await import('../src/logger.js');

const quiet = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quiet[k] = () => {};

const people = [
  { firstName: 'A', lastName: 'One', fullName: 'A One', title: 'Estimator', company: 'X', linkedinUrl: 'u1', location: 'Austin' },
  { firstName: 'B', lastName: 'Two', fullName: 'B Two', title: 'Estimator', company: 'Y', linkedinUrl: 'u2', location: 'Austin' },
];
function providers(overrides = {}) {
  return {
    discoverCandidates: async () => people,
    enrichCandidates: async (cs) => cs.map((c) => ({ ...c, email: `${c.firstName}@example.com`, emailType: 'personal' })),
    createCampaign: async (company) => ({ id: 'camp-' + company, name: company }),
    addLeads: async (_id, leads) => ({ added: leads.length, failed: 0 }),
    activateCampaign: async () => true,
    ...overrides,
  };
}
const form = { companyName: 'Acme', titles: ['Estimator'], jobPosition: 'Estimator', location: 'Austin, TX' };

test('previewSearch returns candidates with emails and never sends', async () => {
  let created = false;
  const s = await previewSearch(form, quiet, providers({ createCampaign: async () => { created = true; return {}; } }));
  assert.equal(s.status, 'preview');
  assert.equal(s.groups[0].candidates.length, 2);
  assert.equal(created, false); // preview must not create a campaign
  assert.ok(s.cost.total >= 0);
});

test('commit only sends approved candidates', async () => {
  const s = await previewSearch(form, quiet, providers());
  const r = await commit(s, ['a@example.com'], quiet, providers());
  assert.equal(r.status, 'sent');
  assert.equal(r.sent, 1);
  assert.equal(r.skipped.notApproved, 1);
});

test('commit skips suppressed candidates even if approved', async () => {
  supp.suppress('b@example.com');
  const s = await previewSearch(form, quiet, providers());
  const r = await commit(s, ['a@example.com', 'b@example.com'], quiet, providers());
  assert.equal(r.sent, 1);
  assert.equal(r.skipped.suppressed, 1);
  supp.unsuppress('b@example.com');
});

test('commit skips recently-contacted candidates when a dedupe window is set', async () => {
  settings.updateSettings({ dedupeWindowDays: 30 });
  contacts.recordContacts([{ email: 'a@example.com', company: 'Old', role: 'X' }]);
  const s = await previewSearch(form, quiet, providers());
  const r = await commit(s, ['a@example.com', 'b@example.com'], quiet, providers());
  assert.equal(r.skipped.recent, 1); // a@ was contacted just now
  assert.equal(r.sent, 1); // only b@ goes
  settings.updateSettings({ dedupeWindowDays: 0 });
});

test('dry-run commit sends nothing to providers but reports would-add', async () => {
  settings.updateSettings({ dryRun: true });
  let created = false;
  const s = await previewSearch(form, quiet, providers());
  const r = await commit(s, ['a@example.com', 'b@example.com'], quiet, providers({ createCampaign: async () => { created = true; return {}; } }));
  assert.equal(r.status, 'dry_run');
  assert.equal(created, false);
  assert.equal(r.sent, 2); // would-add count
  settings.updateSettings({ dryRun: false });
});

test('previewPool matches against the pool and surfaces scores', async () => {
  // The old version of this test used the "Estimator" fixture and wrapped every assertion in
  // `if (s.groups.length)`. Estimators cannot match a software-engineering pool at threshold 60,
  // so groups was always empty, the body never ran, and the test asserted NOTHING while green.
  // Use candidates that genuinely match the example pool, and assert the match unconditionally.
  const engineers = [
    {
      firstName: 'Grace', lastName: 'Hopper', fullName: 'Grace Hopper', title: 'Senior Backend Engineer',
      seniority: 'senior', company: 'Stripe', headline: 'Go, Kubernetes, PostgreSQL, AWS, microservices',
      linkedinUrl: 'lk-grace', location: 'New York, New York',
    },
  ];
  const s = await previewPool(quiet, providers({ discoverCandidates: async () => engineers }));

  assert.equal(s.kind, 'pool');
  assert.ok(s.groups.length > 0, `expected a match but got status "${s.status}" with no groups`);
  const c = s.groups[0].candidates[0];
  assert.equal(typeof c.score, 'number', 'a matched candidate must carry a numeric score');
  assert.ok(c.score >= 60, `score ${c.score} should clear the default threshold`);
  assert.ok(c.breakdown, 'the operator needs the score breakdown to review the match');
  assert.equal(typeof c.breakdown.skills, 'number');
});

test('previewPool enriches ONLY the top finalists, not the whole wide net', async () => {
  // 30 discovered per role, but only the top `maxCandidates` should ever be enriched.
  settings.updateSettings({ discoverLimit: 30, maxCandidates: 5 });
  const wide = Array.from({ length: 30 }, (_, i) => ({
    firstName: 'C' + i, lastName: 'X', fullName: 'C' + i + ' X', title: 'Senior Backend Engineer',
    company: 'Acme', headline: 'Go Kubernetes PostgreSQL AWS microservices', linkedinUrl: 'lk-' + i, location: 'NY',
  }));
  let enrichedCount = 0;
  const prov = providers({
    discoverCandidates: async () => wide,
    enrichCandidates: async (cs) => { enrichedCount = cs.length; return cs.map((c) => ({ ...c, email: c.linkedinUrl + '@x.com', emailType: 'personal' })); },
  });
  const s = await previewPool(quiet, prov);
  assert.equal(s.discovered, 30);
  assert.equal(s.prescreened, 5);
  assert.equal(enrichedCount, 5); // only the 5 finalists were enriched (paid step bounded)
  settings.updateSettings({ discoverLimit: 100, maxCandidates: 25 });
});
