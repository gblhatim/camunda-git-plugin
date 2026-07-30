/**
 * The team overview's join layer.
 *
 * `assemble` is the pure step that turns the workstream list, the ahead/behind
 * counts, and the open merge requests into one ordered row per workstream. No
 * git, no network - data in, rows out - so the filtering, the staleness rule,
 * the merge-request join, and the attention-first ordering are all checked
 * here in isolation. `summarize` counts what the header leads with.
 *
 * Plain `node test/overview.test.js`.
 */

'use strict';

const assert = require('assert');
const { assemble, summarize } = require('../menu/overview-service');

const NOW = new Date('2026-07-28T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// A workstream list in the shape branch-service.listWorkstreams returns.
function workstreams(streams) {
  return { streams, main: 'main', release: null, current: 'feature/a' };
}

const cases = [
  [ 'the shared and release branches are not rows', () => {
    const rows = assemble({
      workstreams: workstreams([
        { name: 'main', title: 'main', isMain: true },
        { name: 'release/1.2', title: 'release/1.2', isRelease: true },
        { name: 'feature/a', title: 'A', lastChange: daysAgo(1) }
      ]),
      counts: {}, mrsBySource: {}, now: NOW, staleDays: 14
    });

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'feature/a');
  } ],

  [ 'a workstream quiet past the threshold is stale', () => {
    const [ row ] = assemble({
      workstreams: workstreams([ { name: 'feature/a', title: 'A', lastChange: daysAgo(20) } ]),
      counts: {}, mrsBySource: {}, now: NOW, staleDays: 14
    });

    assert.strictEqual(row.stale, true);
    assert.strictEqual(row.ageDays, 20);
  } ],

  [ 'a recently active workstream is not stale', () => {
    const [ row ] = assemble({
      workstreams: workstreams([ { name: 'feature/a', title: 'A', lastChange: daysAgo(2) } ]),
      counts: {}, mrsBySource: {}, now: NOW, staleDays: 14
    });

    assert.strictEqual(row.stale, false);
  } ],

  [ 'the ahead/behind counts are carried onto the row', () => {
    const [ row ] = assemble({
      workstreams: workstreams([ { name: 'feature/a', title: 'A', lastChange: daysAgo(1) } ]),
      counts: { 'feature/a': { ahead: 3, behind: 5 } },
      mrsBySource: {}, now: NOW, staleDays: 14
    });

    assert.strictEqual(row.ahead, 3);
    assert.strictEqual(row.behind, 5);
  } ],

  [ 'an open request is joined to its source branch', () => {
    const [ row ] = assemble({
      workstreams: workstreams([ { name: 'feature/a', title: 'A', lastChange: daysAgo(1) } ]),
      counts: {},
      mrsBySource: {
        'feature/a': {
          number: 7, url: 'http://x/7', target: 'main',
          hasConflicts: true, reviewState: 'changes_requested', stale: false, draft: false
        }
      },
      now: NOW, staleDays: 14
    });

    assert.ok(row.mr, 'the row has its request');
    assert.strictEqual(row.mr.number, 7);
    assert.strictEqual(row.mr.target, 'main');
    assert.strictEqual(row.mr.hasConflicts, true);
    assert.strictEqual(row.mr.reviewState, 'changes_requested');
  } ],

  [ 'a workstream with no request has a null mr', () => {
    const [ row ] = assemble({
      workstreams: workstreams([ { name: 'feature/a', title: 'A', lastChange: daysAgo(1) } ]),
      counts: {}, mrsBySource: {}, now: NOW, staleDays: 14
    });

    assert.strictEqual(row.mr, null);
  } ],

  [ 'ordering puts a conflicting request first, then stale, then furthest behind', () => {
    const rows = assemble({
      workstreams: workstreams([
        { name: 'quiet', title: 'Quiet', lastChange: daysAgo(30) },
        { name: 'behind', title: 'Behind', lastChange: daysAgo(1) },
        { name: 'clashing', title: 'Clashing', lastChange: daysAgo(1) },
        { name: 'calm', title: 'Calm', lastChange: daysAgo(1) }
      ]),
      counts: { behind: { ahead: 0, behind: 9 } },
      mrsBySource: { clashing: { number: 1, hasConflicts: true } },
      now: NOW, staleDays: 14
    });

    assert.deepStrictEqual(
      rows.map(r => r.name),
      [ 'clashing', 'quiet', 'behind', 'calm' ]
    );
  } ],

  [ 'summarize counts what the header leads with', () => {
    const rows = assemble({
      workstreams: workstreams([
        { name: 'a', title: 'A', lastChange: daysAgo(30), localOnly: true },
        { name: 'b', title: 'B', lastChange: daysAgo(1) },
        { name: 'c', title: 'C', lastChange: daysAgo(1) }
      ]),
      counts: {},
      mrsBySource: {
        b: { number: 2, hasConflicts: true },
        c: { number: 3, hasConflicts: false }
      },
      now: NOW, staleDays: 14
    });

    const s = summarize(rows);

    assert.strictEqual(s.active, 3);
    assert.strictEqual(s.stale, 1, 'a is quiet 30 days');
    assert.strictEqual(s.unsent, 1, 'a is local only');
    assert.strictEqual(s.withOpenMr, 2);
    assert.strictEqual(s.conflicting, 1, 'only b conflicts');
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
