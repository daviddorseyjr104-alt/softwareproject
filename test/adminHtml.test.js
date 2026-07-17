// Structural smoke test for the admin console's markup.
//
// This exists because a regex-based edit rendered Python's None into five panels' class
// attributes — `class="panelNone"` — so they lost the `panel` class entirely. Clicking any tab
// deactivated the dashboard and activated nothing: the console showed a blank page and the API
// keys screen was unreachable, which made the whole app unusable. It shipped to production.
//
// Nothing caught it. `node --check` only parses the inline <script>; the tests never touched the
// HTML; and the server happily served a broken page. These assertions are cheap and would each
// have failed loudly on that commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin.html'), 'utf8');

const tabs = [...html.matchAll(/<button role="tab" data-tab="([a-z]+)"/g)].map((m) => m[1]);
const panels = [...html.matchAll(/<section class="([^"]*)" id="panel-([a-z]+)"/g)]
  .map((m) => ({ cls: m[1], id: m[2] }));

test('every nav tab has a panel, and every panel has a tab', () => {
  assert.ok(tabs.length >= 6, `expected the six workspace tabs, found ${tabs.length}`);
  for (const tab of tabs) {
    assert.ok(panels.some((p) => p.id === tab), `tab "${tab}" has no matching #panel-${tab}`);
  }
  for (const p of panels) {
    assert.ok(tabs.includes(p.id), `#panel-${p.id} has no tab to reach it`);
  }
});

test('every panel actually carries the "panel" class', () => {
  // selectTab() does querySelectorAll('.panel') — a panel missing this class can never be shown,
  // and switching to it leaves NO panel active, i.e. a blank console.
  for (const p of panels) {
    const classes = p.cls.split(/\s+/);
    assert.ok(classes.includes('panel'), `#panel-${p.id} has class="${p.cls}" — it must include "panel"`);
    for (const c of classes) {
      assert.ok(/^[a-z-]+$/.test(c), `#panel-${p.id} has a suspicious class "${c}" (templating accident?)`);
    }
  }
});

test('exactly one panel starts active', () => {
  const active = panels.filter((p) => p.cls.split(/\s+/).includes('active'));
  assert.equal(active.length, 1, `expected 1 panel active on load, found ${active.length}`);
  assert.equal(active[0].id, 'dashboard', 'the dashboard should be the landing panel');
});

test('no templating artifacts leaked into the markup', () => {
  // "panelNone" came from an f-string rendering a None group. Catch the whole family.
  for (const bad of ['None', 'undefined', 'NaN', '[object Object]']) {
    assert.ok(!html.includes(`"${bad}`), `found "${bad}" in an attribute — a templating accident`);
  }
});

test('every form control has an associated label', () => {
  // Screen readers announce an unlabelled input as "edit text" with no idea what it is.
  const bare = [...html.matchAll(/<label>(?!\s*<)/g)];
  assert.equal(bare.length, 0, `${bare.length} <label> without a for= attribute`);
  for (const m of html.matchAll(/<label for="([^"]+)"/g)) {
    assert.ok(
      html.includes(`id="${m[1]}"`),
      `<label for="${m[1]}"> points at an id that does not exist`,
    );
  }
});

test('the tablist is announced correctly', () => {
  assert.ok(html.includes('role="tablist"'), 'the nav must be a tablist');
  assert.equal((html.match(/role="tabpanel"/g) || []).length, panels.length, 'every panel needs role=tabpanel');
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, 'exactly one tab starts selected');
});
