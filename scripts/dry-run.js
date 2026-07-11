// End-to-end dry run using a sample form payload — exercises Apollo + SalesQL for real
// (uses your live keys/credits) but NEVER creates anything in Instantly.
//   npm run dry-run
//
// Override the sample via env: TITLE, CITY, STATE, COMPANY
import { setDryRunOverride } from '../src/settings.js';
import { parseForm } from '../src/form.js';
import { runPipeline } from '../src/pipeline.js';
import { logger } from '../src/logger.js';

// Force dry run for this script regardless of settings.
setDryRunOverride(true);

const samplePayload = {
  companyName: process.env.COMPANY || 'Test Company',
  companyCity: process.env.CITY || 'Austin',
  companyState: process.env.STATE || 'Texas',
  jobPositionName: process.env.TITLE || 'Senior Project Manager',
  jobSalary: '$120,000',
  positionsIAmLookingFor: 'Project Manager, Estimator',
};

const { form, errors } = parseForm(samplePayload);
if (errors.length) {
  console.error('Sample form invalid:', errors);
  process.exit(1);
}

console.log('Running DRY RUN for:', form.companyName, '| titles:', form.titles, '| location:', form.location, '\n');

runPipeline(form, logger.child({ requestId: 'dry-run' }))
  .then((summary) => {
    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((err) => {
    console.error('Dry run failed:', err.message);
    process.exit(1);
  });
