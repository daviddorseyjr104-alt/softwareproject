// Reusable live API-key verification. One minimal, safe, read-only call per service.
// Used by both `npm run test-keys` (CLI) and the admin "Test keys" button.
// Creates nothing, sends no email. Each check returns { ok, status, detail }.
//   status: 'valid' | 'bad' | 'unset' | 'error'

const TIMEOUT = 15000;

async function call(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body: body.slice(0, 300) };
  } catch (err) {
    return { status: 0, ok: false, body: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function verdict(res) {
  if (res.status === 0) return { ok: false, status: 'error', detail: `unreachable (${res.body})` };
  if (res.status === 401 || res.status === 403) return { ok: false, status: 'bad', detail: `bad/insufficient key (HTTP ${res.status})` };
  if (res.ok) return { ok: true, status: 'valid', detail: 'valid' };
  return { ok: false, status: 'error', detail: `HTTP ${res.status} — ${res.body}` };
}

const unset = { ok: false, status: 'unset', detail: 'not set' };

export async function checkApolloKey(apiKey) {
  if (!apiKey) return unset;
  const res = await call('https://api.apollo.io/v1/auth/health', {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  // Apollo returns HTTP 200 even for a bad key — the real signal is `is_logged_in` in the body.
  if (res.ok) {
    let loggedIn = false;
    try { loggedIn = JSON.parse(res.body)?.is_logged_in === true; } catch { /* ignore */ }
    return loggedIn
      ? { ok: true, status: 'valid', detail: 'valid' }
      : { ok: false, status: 'bad', detail: 'bad key (is_logged_in=false)' };
  }
  return verdict(res);
}

export async function checkSalesqlKey(apiKey) {
  if (!apiKey) return unset;
  // Bogus profile: valid key -> 200/404 + empty (no credit charged); invalid key -> 401.
  const url = 'https://api-public.salesql.com/v1/persons/enrich?linkedin_url=' +
    encodeURIComponent('https://www.linkedin.com/in/__salesql-key-probe-does-not-exist__');
  const res = await call(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  if (res.status === 404) return { ok: true, status: 'valid', detail: 'valid (probe profile not found — expected)' };
  return verdict(res);
}

export async function checkInstantlyKey(apiKey) {
  if (!apiKey) return unset;
  const res = await call('https://api.instantly.ai/api/v2/campaigns?limit=1', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  return verdict(res);
}

export async function checkAnthropicKey(apiKey) {
  if (!apiKey) return { ...unset, detail: 'not set (optional — AI fit score)' };
  const res = await call('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  return verdict(res);
}

/**
 * @param {{apollo?:string, salesql?:string, instantly?:string, anthropic?:string}} keys
 * @returns {Promise<{apollo,salesql,instantly,anthropic}>} each an { ok, status, detail }
 */
export async function checkAllKeys(keys = {}) {
  const [apollo, salesql, instantly, anthropic] = await Promise.all([
    checkApolloKey(keys.apollo),
    checkSalesqlKey(keys.salesql),
    checkInstantlyKey(keys.instantly),
    checkAnthropicKey(keys.anthropic),
  ]);
  return { apollo, salesql, instantly, anthropic };
}
