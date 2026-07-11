// Run the multi-company matching pipeline over your pool (data/companies.json).
//   npm run match           -> DRY RUN (scores + matches, creates nothing in Instantly)
//   npm run match -- --live -> actually create Instantly campaigns
//
// Uses live Apollo + SalesQL credits, and Anthropic credits if ANTHROPIC_API_KEY is set.
// With --demo, everything is faked (no keys, no network).
import { getSettings, setDryRunOverride } from '../src/settings.js';
import { logger } from '../src/logger.js';
import { runPoolPipeline } from '../src/poolPipeline.js';
import { defaultProviders } from '../src/pipeline.js';
import { demoProviders } from '../src/providers/demo.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const demo = args.includes('--demo');

if (!live) setDryRunOverride(true); // safe by default

const providers = demo ? demoProviders : defaultProviders;
const config = getSettings();

console.log(
  `Running pool match — ${demo ? 'DEMO (fake providers)' : 'live discovery/enrichment'}, ` +
    `${config.dryRun ? 'DRY RUN (no campaigns created)' : 'LIVE (campaigns will be created)'}, ` +
    `AI scoring ${config.ai.apiKey ? 'ON' : 'OFF (deterministic only)'}\n`,
);

runPoolPipeline(logger.child({ run: 'match' }), providers)
  .then((summary) => {
    console.log('\n=== MATCH SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((err) => {
    console.error('Match run failed:', err.message);
    process.exit(1);
  });
