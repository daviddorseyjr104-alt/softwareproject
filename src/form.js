// Normalizes the incoming GoHighLevel / Flowsa form webhook into a stable shape.
// GHL/Flowsa payloads are inconsistent: fields may be top-level, under `customData`,
// snake_case, Title Case, or keyed by field id. We match on normalized key fragments.

const FIELD_MATCHERS = {
  companyName: ['companyname', 'company', 'clientcompany', 'hiringcompany', 'businessname'],
  companyCity: ['companycity', 'city'],
  companyState: ['companystate', 'state', 'region'],
  jobPosition: ['jobpositionname', 'jobposition', 'positionname', 'position', 'jobtitle', 'roletitle', 'role'],
  jobSalary: ['jobsalary', 'salary', 'payrange', 'pay', 'compensation'],
  positionsLookingFor: ['positionsiamlookingfor', 'positionslookingfor', 'positions', 'roles', 'otherpositions'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Flatten one level of common nesting (customData/data/fields/payload) into a flat map. */
function flatten(payload) {
  const flat = {};
  const merge = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) merge(v);
      else flat[k] = v;
    }
  };
  merge(payload);
  return flat;
}

function pick(flat, matchers) {
  const entries = Object.entries(flat).map(([k, v]) => [norm(k), v]);
  for (const frag of matchers) {
    // exact normalized match first, then contains
    const exact = entries.find(([k]) => k === frag);
    if (exact && exact[1] != null && exact[1] !== '') return String(exact[1]).trim();
  }
  for (const frag of matchers) {
    const partial = entries.find(([k, v]) => k.includes(frag) && v != null && v !== '');
    if (partial) return String(partial[1]).trim();
  }
  return '';
}

/**
 * @returns {{form: object, errors: string[]}}
 * `form` fields: companyName, companyCity, companyState, jobPosition, jobSalary,
 *                positionsLookingFor (array), titles (array, deduped), location (string)
 */
export function parseForm(payload) {
  const flat = flatten(payload);
  const form = {};
  for (const [field, matchers] of Object.entries(FIELD_MATCHERS)) {
    form[field] = pick(flat, matchers);
  }

  // "Positions I'm looking for" may be a comma/newline list or a multiselect array.
  const rawPositions = form.positionsLookingFor;
  const positions = String(rawPositions || '')
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  form.positionsLookingFor = positions;

  // Titles to search on = the main position + any extra positions, deduped case-insensitively.
  const titleSet = new Map();
  [form.jobPosition, ...positions].filter(Boolean).forEach((t) => {
    const key = t.toLowerCase();
    if (!titleSet.has(key)) titleSet.set(key, t);
  });
  form.titles = [...titleSet.values()];

  form.location = [form.companyCity, form.companyState].filter(Boolean).join(', ');

  const errors = [];
  if (!form.companyName) errors.push('Missing company name.');
  if (form.titles.length === 0) errors.push('Missing job position / titles to search for.');
  if (!form.location) errors.push('Missing company city/state (location).');

  return { form, errors };
}
