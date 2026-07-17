// Logs go to stdout → the hosting provider's aggregator, which has a different retention and
// access-control regime than anything this app controls. The repo gitignores PII and encrypts
// API keys at rest; shipping candidates' personal emails there in cleartext undoes all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/logger.js';

/** Capture what the logger actually writes to the stream. */
function capture(fn) {
  const lines = [];
  const outW = process.stdout.write.bind(process.stdout);
  const errW = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = outW; process.stderr.write = errW; }
  return lines.join('');
}

test('candidate emails are masked, not written in full', () => {
  const out = capture(() => logger.info('enrich failed', { email: 'grace.hopper@example.com' }));
  assert.ok(!out.includes('grace.hopper@example.com'), `raw email leaked into logs: ${out}`);
  assert.ok(out.includes('@example.com'), 'the domain is still useful for debugging');
  assert.ok(/g\*\*\*r@example\.com/.test(out), `expected a masked local part, got: ${out}`);
});

test('emails embedded in a message string are masked too', () => {
  const out = capture(() => logger.warn('could not add lead a.b@corp.io to campaign'));
  assert.ok(!out.includes('a.b@corp.io'));
  assert.ok(out.includes('@corp.io'));
});

test('secrets and LinkedIn URLs are redacted', () => {
  const out = capture(() => logger.error('boom', {
    password: 'hunter2',
    apiKey: 'sk-live-abcdef',
    authorization: 'Bearer xyz',
    linkedinUrl: 'https://linkedin.com/in/grace-hopper',
  }));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('sk-live-abcdef'));
  assert.ok(!out.includes('Bearer xyz'));
  assert.ok(!out.includes('grace-hopper'), 'a LinkedIn URL identifies a person as precisely as their address');
});

test('nested and array values are redacted, and non-PII is left intact', () => {
  const out = capture(() => logger.info('run done', {
    requestId: 'abc-123',
    counts: { discovered: 10, enriched: 4 },
    people: [{ email: 'x.y@test.com' }],
  }));
  assert.ok(!out.includes('x.y@test.com'), 'redaction must recurse into arrays/objects');
  assert.ok(out.includes('abc-123'), 'request ids must survive — they are how runs are traced');
  assert.ok(out.includes('"discovered":10'), 'counts must survive');
});

test('redaction does not choke on cyclic structures', () => {
  const a = { name: 'loop' };
  a.self = a;
  assert.doesNotThrow(() => capture(() => logger.info('cyclic', { a })));
});

// Cycle detection must be PATH-scoped, not "seen anywhere". A shared sibling reference — the
// same role object on two matches, say — is perfectly legal and must render in full. Treating it
// as circular silently deletes real data from the logs.
test('a repeated (non-cyclic) reference renders fully, and is not called circular', () => {
  const role = { id: 'r1', title: 'Staff Engineer' };
  const out = capture(() => logger.info('matches', {
    matches: [{ name: 'A', role }, { name: 'B', role }],
  }));
  assert.ok(!out.includes('[circular]'), `a shared sibling ref was wrongly flagged: ${out}`);
  assert.equal((out.match(/Staff Engineer/g) || []).length, 2, 'both matches must show their role');
});

test('a real cycle is still broken', () => {
  const node = { name: 'a' };
  node.parent = node; // genuine ancestor cycle
  const out = capture(() => logger.info('cycle', { node }));
  assert.ok(out.includes('[circular]'), 'a true cycle must still be broken');
  assert.ok(out.includes('"name":"a"'), 'the rest of the object still logs');
});
