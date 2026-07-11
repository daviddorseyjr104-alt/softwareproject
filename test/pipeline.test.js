import { test } from 'node:test';
import assert from 'node:assert/strict';

// Configure test-company list BEFORE config.js loads (via dynamic import below).
process.env.TEST_COMPANY_NAMES = 'Test Company,Test,Demo';

const { runPipeline, dedupeByEmail } = await import('../src/pipeline.js');
const { logger } = await import('../src/logger.js');

const quietLog = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quietLog[k] = () => {};

const baseForm = { companyName: 'Acme', titles: ['Estimator'], location: 'Austin, TX' };

function mockProviders(overrides = {}) {
  return {
    discoverCandidates: async () => [
      { firstName: 'A', lastName: 'One', fullName: 'A One', title: 'Estimator', company: 'X', linkedinUrl: 'u1', location: 'Austin' },
      { firstName: 'B', lastName: 'Two', fullName: 'B Two', title: 'Estimator', company: 'Y', linkedinUrl: 'u2', location: 'Austin' },
    ],
    enrichCandidates: async (cands) => cands.map((c) => ({ ...c, email: `${c.firstName}@example.com`, emailType: 'personal' })),
    createCampaign: async (company) => ({ id: 'camp-1', name: `${company} – Candidate Outreach` }),
    addLeads: async (_id, cands) => ({ added: cands.length, failed: 0 }),
    activateCampaign: async () => true,
    ...overrides,
  };
}

test('happy path creates a campaign and adds leads', async () => {
  const summary = await runPipeline(baseForm, quietLog, mockProviders());
  assert.equal(summary.status, 'ok');
  assert.equal(summary.discovered, 2);
  assert.equal(summary.enriched, 2);
  assert.equal(summary.campaignId, 'camp-1');
  assert.equal(summary.leadsAdded, 2);
  assert.equal(summary.activated, true);
});

test('no candidates => finishes without a campaign', async () => {
  const summary = await runPipeline(baseForm, quietLog, mockProviders({ discoverCandidates: async () => [] }));
  assert.equal(summary.status, 'no_candidates');
  assert.equal(summary.campaignId, null);
});

test('candidates but no emails => finishes without a campaign', async () => {
  const summary = await runPipeline(baseForm, quietLog, mockProviders({ enrichCandidates: async () => [] }));
  assert.equal(summary.status, 'no_emails');
  assert.equal(summary.campaignId, null);
});

test('Test Company name forces dry run (no campaign created)', async () => {
  let created = false;
  const summary = await runPipeline(
    { ...baseForm, companyName: 'Test Company' },
    quietLog,
    mockProviders({ createCampaign: async () => { created = true; return { id: 'x', name: 'x' }; } }),
  );
  assert.equal(summary.status, 'dry_run');
  assert.equal(created, false);
});

test('dedupeByEmail removes case-insensitive duplicates', () => {
  const out = dedupeByEmail([
    { email: 'a@x.com' }, { email: 'A@X.com' }, { email: 'b@x.com' }, { email: '' },
  ]);
  assert.equal(out.length, 2);
});
