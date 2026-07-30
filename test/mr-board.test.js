/**
 * The merge-request review board's derivation layer.
 *
 * `decorateItems` is the pure, host-independent step that turns the raw MR
 * list into what the board sorts and labels by: how many days each request
 * has been open, and whether that makes it stale. No network, no git - just
 * dates in, flags out - so it is checked in isolation here.
 *
 * Plain `node test/mr-board.test.js`.
 */

'use strict';

const assert = require('assert');
const { decorateItems } = require('../menu/merge-request-service');

// A fixed "now" so the age arithmetic is deterministic.
const NOW = new Date('2026-07-28T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const cases = [
  [ 'age is whole days since it opened', () => {
    const [ mr ] = decorateItems([ { createdAt: daysAgo(3) } ], NOW, 7);
    assert.strictEqual(mr.ageDays, 3);
  } ],

  [ 'opened today is age 0, never negative', () => {
    const [ mr ] = decorateItems([ { createdAt: NOW.toISOString() } ], NOW, 7);
    assert.strictEqual(mr.ageDays, 0);
  } ],

  [ 'past the threshold is stale', () => {
    const [ mr ] = decorateItems([ { createdAt: daysAgo(9) } ], NOW, 7);
    assert.strictEqual(mr.stale, true);
  } ],

  [ 'exactly at the threshold is stale', () => {
    const [ mr ] = decorateItems([ { createdAt: daysAgo(7) } ], NOW, 7);
    assert.strictEqual(mr.stale, true);
  } ],

  [ 'under the threshold is not stale', () => {
    const [ mr ] = decorateItems([ { createdAt: daysAgo(6) } ], NOW, 7);
    assert.strictEqual(mr.stale, false);
  } ],

  [ 'a draft is never stale, however old', () => {
    const [ mr ] = decorateItems([ { createdAt: daysAgo(30), draft: true } ], NOW, 7);
    assert.strictEqual(mr.stale, false);
  } ],

  [ 'a missing date is unknown age and never stale', () => {
    const [ mr ] = decorateItems([ { } ], NOW, 7);
    assert.strictEqual(mr.ageDays, null);
    assert.strictEqual(mr.stale, false);
  } ],

  [ 'the original item is not mutated', () => {
    const input = { createdAt: daysAgo(9) };
    decorateItems([ input ], NOW, 7);
    assert.ok(!('stale' in input), 'decorate must return copies, not edit in place');
  } ]
];

let passed = 0;

for (const [ name, fn ] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n${passed}/${cases.length} passed`);
