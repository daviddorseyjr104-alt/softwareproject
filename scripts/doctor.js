// Readiness doctor: checks everything that can be checked WITHOUT live API keys,
// exercises both pipelines in demo mode, and prints an exact readiness score plus
// precisely what remains to reach a fully-live "100/100".
//   npm run doctor
import { bootConfig } from '../src/config.js';
import { getSettings, setDryRunOverride } from '../src/settings.js';
import { logger } from '../src/logger.js';
import { parseForm } from '../src/form.js';
import { runPipeline } from '../src/pipeline.js';
import { runPoolPipeline } from '../src/poolPipeline.js';
import { demoProviders } from '../src/providers/demo.js';
import { loadPool, loadCompanyTiers } from '../src/pool.js';

const quiet = logger.child({ doctor: true });
for (const k of ['debug', 'info', 'warn', 'error']) quiet[k] = () => {};

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

async function run() {
  // --- Structural checks (must pass; no keys needed) ---
  try {
    const { companies, roles } = loadPool();
    add('Company pool loads', true, `${companies.length} companies, ${roles.length} roles`);
  } catch (e) {
    add('Company pool loads', false, e.message);
  }
  try {
    const { map } = loadCompanyTiers();
    add('Company-tier list loads', map.size > 0, `${map.size} employers`);
  } catch (e) {
    add('Company-tier list loads', false, e.message);
  }

  // --- Form parsing ---
  try {
    const { errors } = parseForm({ companyName: 'X', companyCity: 'A', companyState: 'B', jobPositionName: 'Engineer' });
    add('Form parsing', errors.length === 0, 'nested/messy payloads normalize');
  } catch (e) {
    add('Form parsing', false, e.message);
  }

  // --- Single-company pipeline (demo) ---
  try {
    const { form } = parseForm({ companyName: 'Test Company', companyCity: 'Austin', companyState: 'TX', jobPositionName: 'Backend Engineer' });
    const s = await runPipeline(form, quiet, demoProviders);
    add('Single-company pipeline (demo)', s.discovered > 0, `discovered ${s.discovered}, status ${s.status}`);
  } catch (e) {
    add('Single-company pipeline (demo)', false, e.message);
  }

  // --- Matching engine (demo) ---
  try {
    setDryRunOverride(true);
    const s = await runPoolPipeline(quiet, demoProviders);
    setDryRunOverride(undefined);
    add('Matching engine (demo)', s.matched >= 0 && s.discovered > 0,
      `discovered ${s.discovered}, enriched ${s.enriched}, matched ${s.matched}`);
  } catch (e) {
    add('Matching engine (demo)', false, e.message);
  }

  // --- Live-readiness (keys) — informational, not pass/fail for the code ---
  const config = getSettings();
  const live = [
    ['APOLLO_API_KEY (discovery)', !!config.apollo.apiKey],
    ['SALESQL_API_KEY (personal emails)', !!config.salesql.apiKey],
    ['INSTANTLY_API_KEY (campaigns)', !!config.instantly.apiKey],
    ['ANTHROPIC_API_KEY (AI fit score — optional)', !!config.ai.apiKey],
    ['WEBHOOK_SECRET (endpoint auth)', !!bootConfig.webhookSecret],
  ];

  // --- Report ---
  const codeOk = checks.filter((c) => c.ok).length;
  console.log('\n  CODE / WIRING  (works with no keys)');
  for (const c of checks) console.log(`   ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);

  console.log('\n  LIVE CREDENTIALS  (you must supply these)');
  for (const [name, ok] of live) console.log(`   ${ok ? '✅' : '⬜'} ${name}`);

  const codePct = Math.round((codeOk / checks.length) * 100);
  const liveHave = live.filter(([, ok]) => ok).length;
  const livePct = Math.round((liveHave / live.length) * 100);
  // Overall: code readiness is 60% of the story, live keys the other 40%.
  const overall = Math.round(codePct * 0.6 + livePct * 0.4);

  console.log('\n  ─────────────────────────────────────────');
  console.log(`   Code/logic readiness : ${codePct}/100  (${codeOk}/${checks.length} checks)`);
  console.log(`   Live-key readiness   : ${livePct}/100  (${liveHave}/${live.length} keys present)`);
  console.log(`   OVERALL              : ${overall}/100`);
  console.log('  ─────────────────────────────────────────');

  if (overall < 100) {
    console.log('\n  To reach 100/100:');
    for (const [name, ok] of live) if (!ok) console.log(`   • Set ${name.split(' (')[0]} (in .env, or via the /admin settings page)`);
    if (checks.some((c) => !c.ok)) console.log('   • Fix the ❌ code checks above');
    console.log('   • Then: npm run test-keys, npm run dry-run, then npm run match -- --live');
  } else {
    console.log('\n  🎉 Fully wired and keyed. Run `npm run match -- --live` to go.');
  }

  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

run();
