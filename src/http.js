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
export async function request(url, opts = {}) {
  const { timeoutMs = 20000, retries = 3, log = logger, ...fetchOpts } = opts;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      }

      const retryable = res.status === 429 || res.status >= 500;
      const bodyText = await res.text().catch(() => '');

      if (retryable && attempt <= retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 15000);
        log.warn('http retry', { url, status: res.status, attempt, backoffMs: backoff });
        await sleep(backoff);
        continue;
      }

      throw new HttpError(`HTTP ${res.status} from ${url}`, {
        status: res.status,
        url,
        body: safeJson(bodyText),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;

      // Network / abort error — retry if attempts remain.
      const isAbort = err.name === 'AbortError';
      if (attempt <= retries) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
        log.warn('http network retry', { url, attempt, reason: isAbort ? 'timeout' : err.message, backoffMs: backoff });
        await sleep(backoff);
        continue;
      }
      throw new HttpError(`Request to ${url} failed: ${isAbort ? 'timeout' : err.message}`, { url });
    }
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
