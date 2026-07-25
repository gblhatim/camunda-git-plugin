/**
 * Tests for the three-way semantic merge analysis.
 *
 * Deliberately dependency-light: plain `node test/merge.test.js`, no runner,
 * matching the rest of the plugin. Each case builds three tiny processes -
 * base, ours, theirs - and asserts how one element is classified, because the
 * whole value of the analysis is telling an auto-merge apart from a real
 * conflict, and that distinction is exactly where a shape-oriented differ and
 * a naive two-way diff both get it wrong.
 */

'use strict';

const assert = require('assert');

const { merge } = require('../menu/diagram-diff-service');

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';

const wrap = inner =>
  `<?xml version="1.0"?>\n` +
  `<bpmn:definitions ${NS} targetNamespace="x">` +
  `<bpmn:process id="P">${inner}</bpmn:process></bpmn:definitions>`;

// Every assertion runs; failures are collected so one broken case does not
// hide the rest.
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

const clean = (r, id) => r.clean.find(e => e.id === id);
const conflict = (r, id) => r.conflicts.find(e => e.id === id);

async function run() {

  await test('needs a base and both sides, or it is not mergeable', async () => {
    assert.strictEqual((await merge(null, '<x/>', '<x/>')).mergeable, false);
    assert.strictEqual((await merge('<x/>', null, '<x/>')).mergeable, false);
  });

  await test('invalid BPMN reports unmergeable rather than throwing', async () => {
    const r = await merge('not xml', wrap(''), wrap(''));
    assert.strictEqual(r.mergeable, false);
    assert.ok(/valid BPMN/.test(r.reason));
  });

  await test('one side changes a property, the other never touches it: auto', async () => {
    const base = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${a}" />');
    const ours = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${b}" />');
    const theirs = base;

    const r = await merge(base, ours, theirs);

    assert.ok(clean(r, 'T'), 'T should be a clean auto-merge');
    assert.strictEqual(conflict(r, 'T'), undefined, 'T must not be a conflict');
    assert.strictEqual(clean(r, 'T').kind, 'change');
    assert.strictEqual(clean(r, 'T').changes[0].side, 'ours');
    assert.strictEqual(r.summary.conflicts, 0);
  });

  await test('both sides edit the SAME property differently: conflict', async () => {
    const base = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${a}" />');
    const ours = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${b}" />');
    const theirs = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${c}" />');

    const r = await merge(base, ours, theirs);
    const c = conflict(r, 'T');

    assert.ok(c, 'T should be a conflict');
    assert.strictEqual(c.kind, 'property');
    assert.strictEqual(c.changes.length, 1);
    assert.deepStrictEqual(
      { base: c.changes[0].base, ours: c.changes[0].ours, theirs: c.changes[0].theirs },
      { base: '${a}', ours: '${b}', theirs: '${c}' }
    );
  });

  await test('both sides edit the same property to the SAME value: no conflict', async () => {
    const base = wrap('<bpmn:serviceTask id="T" camunda:asyncBefore="false" />');
    const ours = wrap('<bpmn:serviceTask id="T" camunda:asyncBefore="true" />');
    const theirs = ours;

    const r = await merge(base, ours, theirs);

    assert.strictEqual(conflict(r, 'T'), undefined);
    // Agreement is not a change to report - both sides already hold it.
    assert.strictEqual(clean(r, 'T'), undefined);
  });

  await test('each side edits a DIFFERENT property of the same element: auto, combined', async () => {
    // The case file-level resolution destroys: two people improving one task
    // without colliding.
    const base = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="false" />');
    const ours = wrap('<bpmn:serviceTask id="T" name="Charge card" camunda:asyncBefore="false" />');
    const theirs = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="true" />');

    const r = await merge(base, ours, theirs);
    const c = clean(r, 'T');

    assert.ok(c, 'T should combine cleanly');
    assert.strictEqual(conflict(r, 'T'), undefined);
    assert.strictEqual(c.changes.length, 2);
    const bySide = Object.fromEntries(c.changes.map(x => [ x.label, x.side ]));
    assert.strictEqual(bySide['Name'], 'ours');
    assert.strictEqual(bySide['Asynchronous before'], 'theirs');
  });

  await test('added by one side only: clean add', async () => {
    const base = wrap('');
    const ours = wrap('<bpmn:userTask id="N" name="Review" />');
    const theirs = base;

    const r = await merge(base, ours, theirs);
    assert.strictEqual(clean(r, 'N').kind, 'add');
    assert.strictEqual(clean(r, 'N').side, 'ours');
  });

  await test('added by both under the same id, differing: add/add conflict', async () => {
    const base = wrap('');
    const ours = wrap('<bpmn:userTask id="N" name="Review order" />');
    const theirs = wrap('<bpmn:userTask id="N" name="Approve order" />');

    const r = await merge(base, ours, theirs);
    const c = conflict(r, 'N');
    assert.strictEqual(c.kind, 'add/add');
    // No ancestor, so the base column is null.
    assert.strictEqual(c.changes[0].base, null);
  });

  await test('deleted one side, untouched the other: the deletion stands (auto)', async () => {
    const base = wrap('<bpmn:task id="T" name="Old" />');
    const ours = wrap('');
    const theirs = base;

    const r = await merge(base, ours, theirs);
    const c = clean(r, 'T');
    assert.strictEqual(c.kind, 'remove');
    assert.strictEqual(c.side, 'ours');
    assert.strictEqual(conflict(r, 'T'), undefined);
  });

  await test('deleted one side, edited the other: delete/modify conflict', async () => {
    const base = wrap('<bpmn:task id="T" name="Old" />');
    const ours = wrap('');
    const theirs = wrap('<bpmn:task id="T" name="Renamed" />');

    const r = await merge(base, ours, theirs);
    const c = conflict(r, 'T');
    assert.strictEqual(c.kind, 'delete/modify');
    assert.strictEqual(c.removedBy, 'ours');
    assert.strictEqual(c.changes[0].from, 'Old');
    assert.strictEqual(c.changes[0].to, 'Renamed');
  });

  await test('summary.combinesCleanly is true only when nothing conflicts', async () => {
    const base = wrap('<bpmn:task id="T" name="A" />');
    const cleanCase = await merge(base, wrap('<bpmn:task id="T" name="B" />'), base);
    assert.strictEqual(cleanCase.summary.combinesCleanly, true);

    const conflictCase = await merge(
      base,
      wrap('<bpmn:task id="T" name="B" />'),
      wrap('<bpmn:task id="T" name="C" />')
    );
    assert.strictEqual(conflictCase.summary.combinesCleanly, false);
  });

  // ---- report ----
  const failed = results.filter(r => !r.ok);

  results.forEach(r => {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok) {
      console.log(`     ${r.err.message}`);
    }
  });

  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length) {
    process.exit(1);
  }
}

run();
