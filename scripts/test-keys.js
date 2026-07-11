// Live API-key verifier (CLI). Uses the shared src/keyCheck.js — one safe, read-only call per
// service — against whatever keys are currently effective (settings store or env). Creates
// nothing, sends no email.
//   npm run test-keys
import { getSettings } from '../src/settings.js';
import { checkAllKeys } from '../src/keyCheck.js';

async function main() {
  console.log('\nTesting API keys (safe, read-only calls — nothing is created or sent)…\n');
  const s = getSettings();
  const results = await checkAllKeys({
    apollo: s.apollo.apiKey,
    salesql: s.salesql.apiKey,
    instantly: s.instantly.apiKey,
    anthropic: s.ai.apiKey,
  });

  const mark = (r) => ({ valid: '✅', bad: '❌', error: '⚠️', unset: '⬜' }[r.status] || '⬜');
  const rows = [
    ['Apollo    (discovery)', results.apollo],
    ['SalesQL   (personal emails)', results.salesql],
    ['Instantly (campaigns)', results.instantly],
    ['Anthropic (AI fit — optional)', results.anthropic],
  ];
  for (const [name, r] of rows) console.log(`  ${mark(r)}  ${name.padEnd(32)} ${r.detail}`);

  const allRequiredValid = [results.apollo, results.salesql, results.instantly].every((r) => r.ok);
  console.log('');
  if (allRequiredValid) {
    console.log('  🎉 All required keys are live. Next: `npm run dry-run`, then `npm run match -- --live`.');
  } else {
    console.log('  Fix any ❌ / ⚠️ above. ⬜ = not set yet.');
    if (results.salesql.status === 'bad') {
      console.log('  Note: SalesQL API needs a PAID plan (Professional+) — free accounts have no API access.');
    }
  }
  console.log('');
}

main();
