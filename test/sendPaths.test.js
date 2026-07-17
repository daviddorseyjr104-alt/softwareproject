// The do-not-contact list is the app's one irreversible promise: someone who asked never to be
// emailed must never be emailed. There are THREE send paths (webhook, pool auto-run, admin
// approval), and the guard used to be hand-copied into each — so poolPipeline.js, the path that
// auto-sends with NO human review, simply never got a copy. A suppressed address was handed to
// Instantly by POST /run-pool while the entire suite passed green.
//
// This file is table-driven ON PURPOSE. Every send path runs the same assertions, so a fourth
// path added later fails here until it routes through the shared gate in src/sendGate.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = join(os.tmpdir(), 'cf-sendpaths-' + Math.random().toString(36).slice(2));
process.env.DRY_RUN = 'false'; // exercise the REAL send branch — dry-run would hide the bug
delete process.env.ANTHROPIC_API_KEY;

const supp = await import('../src/suppression.js');
const contacts = await import('../src/contacts.js');
const { runPipeline } = await import('../src/pipeline.js');
const { runPoolPipeline } = await import('../src/poolPipeline.js');
const { commit } = await import('../src/approval.js');
const { logger } = await import('../src/logger.js');

const quietLog = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quietLog[k] = () => {};

const BLOCKED = 'unsubscribed@victim.com';
const OK = 'willing@example.com';

/** Records every email actually handed to Instantly. */
function spyProviders(candidates) {
  const emailed = [];
  return {
    emailed,
    providers: {
      discoverCandidates: async () => candidates,
      enrichCandidates: async (list) => list,
      enrichGithub: async () => null,
      createCampaign: async () => ({ id: 'camp-1', name: 'Test Campaign' }),
      addLeads: async (_id, leads) => {
        emailed.push(...leads.map((l) => l.email));
        return { added: leads.length };
      },
      activateCampaign: async () => true,
    },
  };
}

const candidate = (email, extra = {}) => ({
  fullName: 'Test Person', firstName: 'Test', lastName: 'Person',
  title: 'Senior Backend Engineer', seniority: 'senior', headline: 'Go, Kubernetes, PostgreSQL, AWS, microservices',
  company: 'Stripe', email, emailType: 'personal', linkedinUrl: 'https://linkedin.com/in/' + email,
  ...extra,
});

// Each entry drives one real send path end-to-end with a suppressed + a clean candidate.
const SEND_PATHS = [
  {
    name: 'webhook (runPipeline)',
    run: async (providers) => runPipeline(
      { companyName: 'Acme', titles: ['Senior Backend Engineer'], location: 'NYC', jobPosition: 'Senior Backend Engineer' },
      quietLog, providers,
    ),
  },
  {
    name: 'pool auto-run (runPoolPipeline)',
    run: async (providers) => runPoolPipeline(quietLog, providers),
  },
  {
    name: 'admin approval (commit)',
    // The operator APPROVES everyone — approval must not override the do-not-contact list.
    run: async (providers, emails) => {
      // A preview summary shaped like approval.js builds one.
      const summary = {
        groups: [{
          company: 'Acme', roleTitle: 'Senior Backend Engineer', roleSalary: '$200k',
          candidates: emails.map((email) => ({
            key: email, email, name: 'Test Person',
            _lead: { email, fullName: 'Test Person', company: 'Stripe', title: 'Senior Backend Engineer' },
          })),
        }],
      };
      return commit(summary, emails, quietLog, providers);
    },
  },
];

for (const path of SEND_PATHS) {
  test(`${path.name}: NEVER emails a suppressed address`, async () => {
    supp.suppress(BLOCKED);
    assert.equal(supp.isSuppressed(BLOCKED), true, 'precondition: address is suppressed');

    const { emailed, providers } = spyProviders([candidate(BLOCKED), candidate(OK)]);
    await path.run(providers, [BLOCKED, OK]);

    assert.ok(!emailed.includes(BLOCKED), `${path.name} handed a suppressed address to Instantly: ${emailed}`);
    assert.ok(emailed.includes(OK), `${path.name} should still email the non-suppressed candidate`);
  });

  test(`${path.name}: blocks a whole suppressed domain`, async () => {
    supp.suppress('blocked-co.com');
    const victim = 'anyone@blocked-co.com';
    const { emailed, providers } = spyProviders([candidate(victim), candidate(OK)]);
    await path.run(providers, [victim, OK]);
    assert.ok(!emailed.includes(victim), `${path.name} emailed a suppressed DOMAIN: ${emailed}`);
  });

  test(`${path.name}: records every send to the audit trail`, async () => {
    const fresh = `audit-${path.name.replace(/\W/g, '')}@example.com`;
    const { emailed, providers } = spyProviders([candidate(fresh)]);
    await path.run(providers, [fresh]);
    assert.ok(emailed.includes(fresh), 'precondition: the candidate was emailed');
    // The trail must cover EVERY path — the dedupe window can only protect people
    // whose prior contact was actually written down.
    assert.equal(contacts.lastContactAgeDays(fresh), 0, `${path.name} emailed someone without recording it`);
  });
}

test('@domain.com is treated as a whole-domain block, not an unmatchable email', () => {
  // "@competitor.com" contains an "@", so it used to land in the emails bucket and match
  // nobody — while the operator saw it listed and believed they were protected. It was also
  // unremovable, because unsuppress stripped the "@" and searched for a value that wasn't there.
  supp.suppress('@rival.com');
  assert.equal(supp.isSuppressed('ceo@rival.com'), true, '@rival.com must block the whole domain');
  assert.deepEqual(supp.listSuppression().domains.includes('rival.com'), true, 'must be filed as a domain');
  supp.unsuppress('@rival.com');
  assert.equal(supp.isSuppressed('ceo@rival.com'), false, 'an entry the UI shows must be removable');
});

test('suppress rejects a value that is neither an email nor a domain', () => {
  // A typo'd "john" used to become a silent domain block.
  assert.throws(() => supp.suppress('john'), /not a valid/);
  assert.throws(() => supp.suppress('not an email'), /not a valid/);
  assert.equal(supp.listSuppression().domains.includes('john'), false);
});

// A commit that dies part-way must NOT look like a clean failure. If any leads already reached
// Instantly, releasing the claim lets the operator retry and email those people a SECOND time —
// and the dedupe window is no backstop, since it defaults to 0 (off).
test('a commit that fails part-way reports partialSend so the claim is kept', async () => {
  const summary = {
    groups: [
      { company: 'GroupA', roleTitle: 'Backend', roleSalary: '', candidates: [{ email: 'ga@example.com', _lead: { email: 'ga@example.com' } }] },
      { company: 'GroupB', roleTitle: 'Frontend', roleSalary: '', candidates: [{ email: 'gb@example.com', _lead: { email: 'gb@example.com' } }] },
    ],
  };
  const emailed = [];
  let campaigns = 0;
  const providers = {
    // Group A succeeds; group B's campaign creation blows up — the most throw-prone call, since
    // createCampaign deliberately runs with retries: 0.
    createCampaign: async () => {
      if (++campaigns === 2) throw new Error('HTTP 500 from Instantly /campaigns');
      return { id: 'camp-a' };
    },
    addLeads: async (_id, leads) => { emailed.push(...leads.map((l) => l.email)); return { added: leads.length }; },
    activateCampaign: async () => true,
  };

  await assert.rejects(
    () => commit(summary, ['ga@example.com', 'gb@example.com'], quietLog, providers),
    (err) => {
      assert.equal(emailed.length, 1, 'group A really was emailed before the failure');
      assert.equal(err.partialSend, true,
        'partialSend must be true — without it the server releases the claim and a retry re-emails group A');
      return true;
    },
  );
});

test('a commit that fails before ANY send reports partialSend false, so a retry is allowed', async () => {
  const summary = {
    groups: [{ company: 'GroupA', roleTitle: 'Backend', roleSalary: '', candidates: [{ email: 'nobody@example.com', _lead: { email: 'nobody@example.com' } }] }],
  };
  const providers = {
    createCampaign: async () => { throw new Error('HTTP 401 Unauthorized'); }, // bad key: nothing sent
    addLeads: async () => ({ added: 0 }),
    activateCampaign: async () => true,
  };
  await assert.rejects(
    () => commit(summary, ['nobody@example.com'], quietLog, providers),
    (err) => {
      assert.equal(err.partialSend, false, 'nothing went out — the operator must be able to retry');
      return true;
    },
  );
});
