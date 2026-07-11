// Loads and validates the company/role pool and the company-tier list.
//
// Resolution order (first that exists wins):
//   1. DATA_DIR/<name>.json      — client-edited via the admin UI (persistent volume)
//   2. data/<name>.json          — committed override
//   3. data/<name>.example.json  — sample fallback
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoDataDir = join(here, '..', 'data');

function sourcePath(name) {
  const candidates = [
    join(bootConfig.dataDir, `${name}.json`),
    join(repoDataDir, `${name}.json`),
    join(repoDataDir, `${name}.example.json`),
  ];
  const path = candidates.find(existsSync) || candidates[candidates.length - 1];
  return { path, usingExample: path.endsWith('.example.json') };
}

function loadJson(name) {
  const { path, usingExample } = sourcePath(name);
  return { data: JSON.parse(readFileSync(path, 'utf8')), path, usingExample };
}

function writeToDataDir(name, obj) {
  mkdirSync(bootConfig.dataDir, { recursive: true });
  const target = join(bootConfig.dataDir, `${name}.json`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, target);
  return target;
}

/** Validate a pool object → { companies, roles }. Throws with a clear message on any problem. */
export function validatePool(data) {
  const companies = Array.isArray(data?.companies) ? data.companies : [];
  if (companies.length === 0) throw new Error('Pool has no companies.');

  const roles = [];
  const seenRoleIds = new Set();
  for (const company of companies) {
    if (!company.id || !company.name) throw new Error('A company is missing id/name.');
    const companyRoles = Array.isArray(company.roles) ? company.roles : [];
    for (const role of companyRoles) {
      if (!role.id || !role.title) throw new Error(`Company "${company.name}" has a role missing id/title.`);
      if (seenRoleIds.has(role.id)) throw new Error(`Duplicate role id "${role.id}".`);
      seenRoleIds.add(role.id);
      roles.push({
        ...role,
        searchTitles: role.searchTitles?.length ? role.searchTitles : [role.title],
        requiredSkills: role.requiredSkills || [],
        niceToHaveSkills: role.niceToHaveSkills || [],
        seniority: role.seniority || [],
        location: role.location || company.location || '',
        capacity: Number.isFinite(role.capacity) ? role.capacity : Infinity,
        company: { id: company.id, name: company.name, tier: company.tier ?? 3 },
      });
    }
  }
  if (roles.length === 0) throw new Error('Pool has companies but no roles.');
  return { companies, roles };
}

/** Returns { companies, roles, path, usingExample }. */
export function loadPool() {
  const { data, path, usingExample } = loadJson('companies');
  const { companies, roles } = validatePool(data);
  return { companies, roles, path, usingExample };
}

/** Load the company-tier lookup as a Map<lowercased-name-fragment, tier:number>. */
export function loadCompanyTiers() {
  const { data, path, usingExample } = loadJson('company-tiers');
  const map = new Map();
  for (const [tier, names] of Object.entries(data.tiers || {})) {
    for (const name of names) map.set(name.toLowerCase(), Number(tier));
  }
  return { map, path, usingExample };
}

// ---- admin UI helpers ----------------------------------------------------

/** Raw effective pool JSON (for the editor). */
export function getRawPool() {
  return loadJson('companies');
}
export function getRawTiers() {
  return loadJson('company-tiers');
}

/** Validate + persist a client-edited pool to DATA_DIR. Accepts an object or JSON string. */
export function savePool(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  validatePool(data); // throws on invalid — nothing is written
  return writeToDataDir('companies', data);
}

/** Validate + persist a client-edited tier list to DATA_DIR. */
export function saveTiers(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || typeof data.tiers !== 'object') throw new Error('Tier list must have a "tiers" object.');
  return writeToDataDir('company-tiers', data);
}
