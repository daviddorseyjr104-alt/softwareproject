import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApolloKey, checkSalesqlKey, checkInstantlyKey, checkAllKeys } from '../src/keyCheck.js';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}
const res = (status, body = '') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('unset keys report status "unset" without calling the network', async () => {
  let called = false;
  await withFetch(async () => { called = true; return res(200); }, async () => {
    const r = await checkApolloKey('');
    assert.equal(r.status, 'unset');
    assert.equal(called, false);
  });
});

test('Apollo: HTTP 200 but is_logged_in=false is treated as a bad key', async () => {
  await withFetch(async () => res(200, { is_logged_in: false }), async () => {
    assert.equal((await checkApolloKey('bad')).status, 'bad');
  });
  await withFetch(async () => res(200, { is_logged_in: true }), async () => {
    assert.equal((await checkApolloKey('good')).status, 'valid');
  });
});

test('401 is a bad key; 404 on the SalesQL probe is valid', async () => {
  await withFetch(async () => res(401), async () => {
    assert.equal((await checkInstantlyKey('x')).status, 'bad');
  });
  await withFetch(async () => res(404), async () => {
    assert.equal((await checkSalesqlKey('x')).status, 'valid');
  });
});

test('checkAllKeys returns a verdict per service', async () => {
  await withFetch(async (url) => (String(url).includes('apollo') ? res(200, { is_logged_in: true }) : res(401)), async () => {
    const r = await checkAllKeys({ apollo: 'a', salesql: 's', instantly: 'i', anthropic: 'n' });
    assert.equal(r.apollo.status, 'valid');
    assert.equal(r.instantly.status, 'bad');
  });
});
