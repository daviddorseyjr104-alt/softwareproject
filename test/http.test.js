import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, request, HttpError } from '../src/http.js';

test('mapLimit preserves order and bounds concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [10, 20, 30, 40, 50];
  const out = await mapLimit(items, 2, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [20, 40, 60, 80, 100]);
  assert.ok(maxActive <= 2, `concurrency exceeded: ${maxActive}`);
});

test('request retries on 500 then succeeds', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return new Response('err', { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const data = await request('https://example.test/x', { retries: 3, timeoutMs: 1000 });
    assert.equal(data.ok, true);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('request throws HttpError with status on non-retryable 4xx', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad' }), { status: 400 });
  try {
    await assert.rejects(
      () => request('https://example.test/x', { retries: 2 }),
      (err) => err instanceof HttpError && err.status === 400,
    );
  } finally {
    globalThis.fetch = original;
  }
});
