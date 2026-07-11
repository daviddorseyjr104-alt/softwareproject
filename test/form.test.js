import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForm } from '../src/form.js';

test('parses a nested GHL customData payload with mixed casing', () => {
  const { form, errors } = parseForm({
    customData: {
      'Company Name': 'Acme Builders',
      'Company City': 'Denver',
      company_state: 'Colorado',
      'Job Position Name': 'Senior Project Manager',
      'Job Salary': '$120k',
      'Positions I Am Looking For': 'Project Manager, Estimator; Superintendent',
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(form.companyName, 'Acme Builders');
  assert.equal(form.location, 'Denver, Colorado');
  assert.equal(form.jobSalary, '$120k');
});

test('builds a deduped title list from position + extra positions', () => {
  const { form } = parseForm({
    companyName: 'X',
    companyCity: 'A',
    companyState: 'B',
    jobPositionName: 'Project Manager',
    positionsIAmLookingFor: 'project manager, Estimator', // dup differs only by case
  });
  assert.deepEqual(form.titles, ['Project Manager', 'Estimator']);
});

test('reports errors for missing required fields', () => {
  const { errors } = parseForm({ foo: 'bar' });
  assert.equal(errors.length, 3);
});

test('handles url-encoded flat payload', () => {
  const { form, errors } = parseForm({
    companyName: 'Flat Co',
    companyCity: 'Austin',
    companyState: 'TX',
    jobPosition: 'Estimator',
  });
  assert.deepEqual(errors, []);
  assert.equal(form.company, undefined); // sanity: we use companyName
  assert.deepEqual(form.titles, ['Estimator']);
  assert.equal(form.location, 'Austin, TX');
});
