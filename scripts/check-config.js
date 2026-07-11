// Quick sanity check of the effective configuration without starting the server.
//   npm run check-config
import { bootConfig, bootSafety } from '../src/config.js';
import { getSettings, getMaskedSettings } from '../src/settings.js';

const s = getSettings();
const m = getMaskedSettings();
const keyState = (k) => (m.keys[k].set ? `set (••••${m.keys[k].last4})` : '(not set)');

console.log('Kaizen Candidate Finder — config check\n');
console.log('  Boot (env-only):');
console.log('    PORT              :', bootConfig.port);
console.log('    NODE_ENV          :', bootConfig.nodeEnv);
console.log('    DATA_DIR          :', bootConfig.dataDir);
console.log('    WEBHOOK_SECRET    :', bootConfig.webhookSecret ? 'set' : '(blank)');
console.log('    ADMIN_PASSWORD    :', bootConfig.adminPassword ? 'set' : '(blank)');
console.log('    SECRET_KEY        :', bootConfig.secretKey ? 'set' : '(blank — encryption off)');
console.log('\n  Runtime (settings store / env, editable at /admin):');
console.log('    Apollo key        :', keyState('apollo'));
console.log('    SalesQL key       :', keyState('salesql'));
console.log('    Instantly key     :', keyState('instantly'));
console.log('    Anthropic key     :', keyState('anthropic'));
console.log('    MAX_CANDIDATES    :', s.apollo.maxCandidates);
console.log('    SCORE_THRESHOLD   :', s.scoring.threshold);
console.log('    DRY_RUN           :', s.dryRun);

const { fatal, warnings } = bootSafety();
console.log('\nResult:');
for (const w of warnings) console.log('  ⚠️ ', w);
for (const f of fatal) console.log('  ❌ ', f);
if (fatal.length === 0 && warnings.length === 0) console.log('  ✅ Boot config OK.');
if (fatal.length) process.exitCode = 1;
