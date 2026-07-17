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

// These three branches held real bugs and had NO coverage at all.

test('a 200 with a non-JSON body fails immediately — it is not a network error', async () => {
  // A proxy/captive-portal HTML page returned with status 200 used to throw SyntaxError from
  // INSIDE the retry try-block, so a successful request was retried 3× with backoff and then
  // reported as "Request failed: Unexpected token '<'" — the wrong error, three times the load.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    await assert.rejects(
      () => request('https://example.test/x', { retries: 3, timeoutMs: 500 }),
      (err) => err instanceof HttpError && /Expected JSON/.test(err.message),
    );
    assert.equal(calls, 1, 'a 200 must not be retried');
  } finally {
    globalThis.fetch = original;
  }
});

test('an absurd Retry-After is capped, not obeyed literally', async () => {
  // `Retry-After: 86400` on a 429 meant `await sleep(86_400_000)` — the request held its
  // mapLimit slot for a DAY and stalled every candidate queued behind it.
  const original = globalThis.fetch;
  const sleeps = [];
  const realSetTimeout = globalThis.setTimeout;
  // Capture the requested delay, then fire immediately so the test doesn't actually wait.
  globalThis.setTimeout = (fn, ms) => { if (ms > 100) { sleeps.push(ms); return realSetTimeout(fn, 0); } return realSetTimeout(fn, ms); };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '86400' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const data = await request('https://example.test/x', { retries: 2, timeoutMs: 500 });
    assert.equal(data.ok, true);
    assert.ok(sleeps.length > 0, 'should have backed off once');
    assert.ok(Math.max(...sleeps) <= 60_000, `waited ${Math.max(...sleeps)}ms — must be capped at 60s`);
  } finally {
    globalThis.fetch = original;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a 429 without Retry-After still backs off and retries', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) return new Response('slow down', { status: 429 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const data = await request('https://example.test/x', { retries: 3, timeoutMs: 500 });
    assert.equal(data.ok, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
