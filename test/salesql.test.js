// Verifies SalesQL enrichment keeps only PERSONAL emails when PERSONAL_EMAILS_ONLY=true.
// NOTE: env must be set BEFORE importing the module (config reads env at import time).
// Static `import` is hoisted above assignments, so we use dynamic import() here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SALESQL_API_KEY = 'test-key';
process.env.PERSONAL_EMAILS_ONLY = 'true';

const { enrichCandidates } = await import('../src/providers/salesql.js');
const { logger } = await import('../src/logger.js');

const quietLog = logger.child({ test: true });
for (const k of ['debug', 'info', 'warn', 'error']) quietLog[k] = () => {};

test('keeps personal email, drops candidate with only professional email', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('personal-guy')) {
      return new Response(JSON.stringify({ emails: [
        { email: 'pro@company.com', type: 'professional', status: 'valid' },
        { email: 'me@gmail.com', type: 'personal', status: 'valid' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ emails: [
      { email: 'work@corp.com', type: 'professional', status: 'valid' },
    ] }), { status: 200 });
  };

  try {
    const out = await enrichCandidates([
      { firstName: 'P', linkedinUrl: 'https://linkedin.com/in/personal-guy' },
      { firstName: 'W', linkedinUrl: 'https://linkedin.com/in/work-only' },
    ], quietLog);

    assert.equal(out.length, 1);
    assert.equal(out[0].email, 'me@gmail.com');
    assert.equal(out[0].emailType, 'personal');
  } finally {
    globalThis.fetch = original;
  }
});
