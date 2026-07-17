// Minimal structured logger. No dependencies.
// Levels: debug < info < warn < error

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// Log lines go to stdout → the hosting provider's log aggregator, which has a different
// retention and access-control regime than anything this app controls. The repo carefully
// gitignores PII and encrypts API keys at rest; shipping candidates' personal emails to that
// pipeline in cleartext undoes it. Redact at the sink so no call site has to remember.
const EMAIL_RE = /\b([^\s@,"']+)@([^\s@,"']+\.[a-z]{2,})\b/gi;
const SECRET_KEYS = /^(password|secret|token|apikey|api_key|authorization|cookie)$/i;

/** grace.hopper@example.com → g***r@example.com — enough to correlate, not to contact. */
function maskEmail(_match, local, domain) {
  const head = local[0] || '';
  const tail = local.length > 1 ? local[local.length - 1] : '';
  return `${head}***${tail}@${domain}`;
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return value.replace(EMAIL_RE, maskEmail);
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth, seen) };
  if (!value || typeof value !== 'object') return value;

  // Break cycles rather than returning the object untouched: JSON.stringify would still throw
  // on it, and an exception here would take down whatever request was being logged.
  //
  // `seen` tracks the current PATH, not everything ever visited. Leaving entries in place made
  // cycle detection mean "any object encountered twice anywhere", so an ordinary shared
  // reference — the same `role` object on two matches, say — logged the second one as
  // "[circular]" and silently deleted real data. Only an ancestor of the current node is a cycle.
  if (seen.has(value)) return '[circular]';
  if (depth > 8) return '[deep]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) { out[k] = '[redacted]'; continue; }
      // linkedinUrl identifies a person as precisely as their address.
      if (/^linkedin(url)?$/i.test(k) && typeof v === 'string') { out[k] = '[linkedin]'; continue; }
      out[k] = redact(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value); // leaving this node — it is no longer an ancestor
  }
}

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && typeof meta === 'object' ? meta : meta !== undefined ? { detail: meta } : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(redact(line)) + '\n');
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  /** Returns a child logger that merges `bindings` into every line (e.g. a request id). */
  child(bindings) {
    return {
      debug: (msg, meta) => emit('debug', msg, { ...bindings, ...meta }),
      info: (msg, meta) => emit('info', msg, { ...bindings, ...meta }),
      warn: (msg, meta) => emit('warn', msg, { ...bindings, ...meta }),
      error: (msg, meta) => emit('error', msg, { ...bindings, ...meta }),
      child: (more) => logger.child({ ...bindings, ...more }),
    };
  },
};
