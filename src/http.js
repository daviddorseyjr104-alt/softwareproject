// Resilient HTTP helper built on native fetch (Node 18+).
// - Per-request timeout via AbortController
// - Automatic retry with exponential backoff on 429 / 5xx / network errors
// - Honors Retry-After when present
import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} opts fetch options plus:
 *   @param {number} [opts.timeoutMs=20000]
 *   @param {number} [opts.retries=3]
 *   @param {object} [opts.log] logger to use
 */
const MAX_BACKOFF_MS = 15000;
// A server can legally answer 429 with `Retry-After: 86400`. Honouring that literally parked the
// request for a DAY, holding its mapLimit slot and stalling every candidate queued behind it.
// Past a minute, failing fast and surfacing the rate limit beats a hung run.
const MAX_RETRY_AFTER_MS = 60_000;

export async function request(url, opts = {}) {
  const { timeoutMs = 20000, retries = 3, log = logger, ...fetchOpts } = opts;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let bodyText;
    try {
      res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      // Read the body INSIDE the timeout window: clearing the timer as soon as the headers
      // arrived let a server send headers then trickle the body forever with nothing to abort it.
      bodyText = await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Network / abort error — retry if attempts remain.
      const isAbort = err.name === 'AbortError';
      if (attempt <= retries) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        log.warn('http network retry', { url, attempt, reason: isAbort ? 'timeout' : err.message, backoffMs: backoff });
        await sleep(backoff);
        continue;
      }
      throw new HttpError(`Request to ${url} failed: ${isAbort ? 'timeout' : err.message}`, { url });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      // Parse OUTSIDE the network try/catch. A 200 carrying a proxy's HTML error page used to
      // throw SyntaxError into the retry loop — so a *successful* request was retried three
      // times and then reported as a network failure, hiding the real cause.
      if (!bodyText) return {};
      try {
        return JSON.parse(bodyText);
      } catch {
        throw new HttpError(`Expected JSON from ${url} but got ${res.headers.get('content-type') || 'unknown'}`, {
          status: res.status, url, body: bodyText.slice(0, 500),
        });
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt <= retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
        : Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      log.warn('http retry', { url, status: res.status, attempt, backoffMs: backoff });
      await sleep(backoff);
      continue;
    }

    throw new HttpError(`HTTP ${res.status} from ${url}`, {
      status: res.status,
      url,
      body: safeJson(bodyText),
    });
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text?.slice(0, 500);
  }
}

/** Run async `fn` over `items` with a bounded concurrency. Preserves order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
