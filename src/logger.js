// Minimal structured logger. No dependencies.
// Levels: debug < info < warn < error

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && typeof meta === 'object' ? meta : meta !== undefined ? { detail: meta } : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
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
