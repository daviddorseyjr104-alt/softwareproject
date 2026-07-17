// The single chokepoint every send path must pass through before anyone is emailed.
//
// Why this module exists: the same do-not-contact check was hand-copied into pipeline.js and
// approval.js, and poolPipeline.js — which auto-sends with no human in the loop — simply never
// got a copy. A suppressed address was emailed by POST /run-pool while all 65 tests passed.
// The lesson isn't "add a third copy", it's that a safety rule enforced by convention gets
// forgotten by the next path someone adds. There is now exactly one gate, it is tested once,
// and every sender routes through it.
import { isSuppressed } from './suppression.js';
import { recentlyContacted } from './contacts.js';
import { getSettings } from './settings.js';

/** Cross-run dedup window in days (0 = off). */
export function dedupeWindow() {
  const n = Number(getSettings().dedupeWindowDays);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Partition candidates into those safe to email and those blocked, with the reason.
 *
 * @param {Array<{email:string}>} candidates
 * @param {object} [opts]
 * @param {number} [opts.window] dedupe window in days; defaults to the configured setting
 * @param {object} [opts.log]
 * @returns {{sendable:Array, blocked:Array<{candidate:object, reason:string}>,
 *            skipped:{suppressed:number, recent:number}}}
 */
export function screenForSend(candidates, { window = dedupeWindow(), log } = {}) {
  const sendable = [];
  const blocked = [];
  const skipped = { suppressed: 0, recent: 0 };

  for (const c of candidates || []) {
    // isSuppressed treats a missing email as suppressed — we can't safely contact a blank.
    if (isSuppressed(c.email)) {
      skipped.suppressed++;
      blocked.push({ candidate: c, reason: 'suppressed' });
      continue;
    }
    if (recentlyContacted(c.email, window)) {
      skipped.recent++;
      blocked.push({ candidate: c, reason: 'recently_contacted' });
      continue;
    }
    sendable.push(c);
  }

  if (blocked.length) {
    // Count only — logging the addresses would push PII into the log pipeline.
    log?.info('send gate blocked candidates', { ...skipped, total: blocked.length });
  }
  return { sendable, blocked, skipped };
}
