/**
 * Tests for the panel's area gate. The whole point of the module is what it
 * does with the *edges* - a project that never set the key, a value written
 * by hand, a set that would leave no way back - so that is what is covered.
 *
 * Plain `node test/tab-access.test.js`.
 */

'use strict';

const assert = require('assert');
const tabAccess = require('../menu/tab-access');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

test('a project that never set the key shows everything', () => {
  assert.deepStrictEqual(tabAccess.normalize(undefined), tabAccess.ALL_IDS);
  assert.deepStrictEqual(tabAccess.normalize(null), tabAccess.ALL_IDS);
});

test('a non-array (hand-edited to nonsense) shows everything rather than nothing', () => {
  assert.deepStrictEqual(tabAccess.normalize('git-team'), tabAccess.ALL_IDS);
  assert.deepStrictEqual(tabAccess.normalize({}), tabAccess.ALL_IDS);
});

test('an empty array is a real choice, not "unset"', () => {
  // Everything off still leaves the pinned areas - that is the difference
  // between an empty set and an absent one.
  assert.deepStrictEqual(tabAccess.normalize([]), tabAccess.ALWAYS_ON);
});

test('Settings can never be turned off', () => {
  const out = tabAccess.normalize([ 'git-my-work' ]);
  assert.ok(out.includes('git-settings'));
});

test('unknown ids are dropped', () => {
  const out = tabAccess.normalize([ 'git-my-work', 'git-nonsense' ]);
  assert.ok(!out.includes('git-nonsense'));
  assert.ok(out.includes('git-my-work'));
});

test('the result is in panel order, not the order it was written', () => {
  const out = tabAccess.normalize([ 'git-activity', 'git-my-work', 'git-team' ]);
  const expected = tabAccess.ALL_IDS.filter(id => out.includes(id));
  assert.deepStrictEqual(out, expected);
});

test('duplicates collapse', () => {
  const out = tabAccess.normalize([ 'git-team', 'git-team' ]);
  assert.strictEqual(out.filter(id => id === 'git-team').length, 1);
});

test('isEnabled agrees with normalize', () => {
  assert.strictEqual(tabAccess.isEnabled([ 'git-team' ], 'git-team'), true);
  assert.strictEqual(tabAccess.isEnabled([ 'git-team' ], 'git-ai'), false);
  // Absent means everything, so nothing reads as disabled.
  assert.strictEqual(tabAccess.isEnabled(undefined, 'git-ai'), true);
});

test('every gateable tab has a label and a description for the Settings list', () => {
  tabAccess.TABS.forEach(tab => {
    assert.ok(tab.id && tab.label && tab.description, `incomplete entry: ${tab.id}`);
  });
});

const failed = results.filter(r => !r.ok);
results.forEach(r => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok) console.log(`     ${r.err.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
