/**
 * Tests for the Phase 2 merge *synthesis* (`mergeXml`).
 *
 * Where merge.test.js checks the analysis - "is this a conflict or not" -
 * these check the document it produces: that a cleanly combinable pair is
 * turned into one .bpmn that actually carries both sides' work, which is
 * the thing file-level keep-a-side cannot do. The assertions parse the
 * result back and read it, rather than string-matching XML, so they hold
 * regardless of how moddle chooses to serialise.
 *
 * Deliberately dependency-light: plain `node test/combine.test.js`.
 */

'use strict';

const assert = require('assert');

const {
  mergeXml, parse, indexElements, ownProperties
} = require('../menu/diagram-diff-service');

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';

const wrap = inner =>
  `<?xml version="1.0"?>\n` +
  `<bpmn:definitions ${NS} targetNamespace="x">` +
  `<bpmn:process id="P">${inner}</bpmn:process></bpmn:definitions>`;

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// Read one element's flattened properties out of a serialised document.
async function propsOf(xml, id) {
  const byId = indexElements(await parse(xml));
  const el = byId.get(id);

  return el ? ownProperties(el) : null;
}

async function has(xml, id) {
  return (await propsOf(xml, id)) !== null;
}

async function run() {

  await test('a real clash is not combinable', async () => {
    const base = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${a}" />');
    const ours = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${b}" />');
    const theirs = wrap('<bpmn:serviceTask id="T" camunda:delegateExpression="${c}" />');

    const r = await mergeXml(base, ours, theirs);

    assert.strictEqual(r.combinable, false);
    assert.ok(!r.xml, 'no document should be produced for a clash');
  });

  await test('identical versions have nothing to combine', async () => {
    const base = wrap('<bpmn:task id="T" name="A" />');

    const r = await mergeXml(base, base, base);

    assert.strictEqual(r.combinable, false);
    assert.ok(/nothing to combine/i.test(r.reason));
  });

  await test('different properties of one element are BOTH kept', async () => {
    // The case keep-a-side destroys: two people improving one task.
    const base = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="false" />');
    const ours = wrap('<bpmn:serviceTask id="T" name="Charge card" camunda:asyncBefore="false" />');
    const theirs = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="true" />');

    const r = await mergeXml(base, ours, theirs);

    assert.strictEqual(r.combinable, true, r.reason);

    const props = await propsOf(r.xml, 'T');
    assert.strictEqual(props.name, 'Charge card', 'our rename survives');
    assert.strictEqual(props['@camunda:asyncBefore'], 'true', 'their async flag survives');
  });

  await test('an element theirs added appears in the combined diagram', async () => {
    const base = wrap('<bpmn:task id="A" name="Keep" />');
    const ours = wrap('<bpmn:task id="A" name="Keep, renamed" />');
    const theirs = wrap('<bpmn:task id="A" name="Keep" /><bpmn:userTask id="B" name="New review" />');

    const r = await mergeXml(base, ours, theirs);

    assert.strictEqual(r.combinable, true, r.reason);
    assert.ok(await has(r.xml, 'B'), 'their new task is present');
    assert.strictEqual((await propsOf(r.xml, 'A')).name, 'Keep, renamed', 'our rename is not lost');
  });

  await test('an element theirs removed is dropped when we left it alone', async () => {
    const base = wrap('<bpmn:task id="A" name="Stay" /><bpmn:task id="B" name="Doomed" />');
    const ours = wrap('<bpmn:task id="A" name="Stay, edited" /><bpmn:task id="B" name="Doomed" />');
    const theirs = wrap('<bpmn:task id="A" name="Stay" />');

    const r = await mergeXml(base, ours, theirs);

    assert.strictEqual(r.combinable, true, r.reason);
    assert.ok(!(await has(r.xml, 'B')), 'their deletion is honoured');
    assert.ok(await has(r.xml, 'A'), 'the untouched-by-them, edited-by-us task stays');
    assert.strictEqual((await propsOf(r.xml, 'A')).name, 'Stay, edited');
  });

  await test('both sides adding different elements keeps both', async () => {
    const base = wrap('<bpmn:task id="A" name="Base" />');
    const ours = wrap('<bpmn:task id="A" name="Base" /><bpmn:userTask id="O" name="Mine" />');
    const theirs = wrap('<bpmn:task id="A" name="Base" /><bpmn:serviceTask id="T" name="Theirs" />');

    const r = await mergeXml(base, ours, theirs);

    assert.strictEqual(r.combinable, true, r.reason);
    assert.ok(await has(r.xml, 'O'), 'our addition survives');
    assert.ok(await has(r.xml, 'T'), 'their addition survives');
  });

  await test('the combined document is valid, re-parseable BPMN', async () => {
    const base = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="false" />');
    const ours = wrap('<bpmn:serviceTask id="T" name="Charge card" camunda:asyncBefore="false" />');
    const theirs = wrap('<bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="true" />');

    const r = await mergeXml(base, ours, theirs);
    await assert.doesNotReject(parse(r.xml), 'combined XML parses');
  });

  await test('applied counts report where each change came from', async () => {
    const base = wrap('<bpmn:task id="A" name="A" />');
    const ours = wrap('<bpmn:task id="A" name="A" /><bpmn:task id="O" name="mine" />');
    const theirs = wrap('<bpmn:task id="A" name="A" /><bpmn:task id="T" name="theirs" />');

    const r = await mergeXml(base, ours, theirs);
    assert.strictEqual(r.combinable, true, r.reason);
    assert.strictEqual(r.applied.fromOurs, 1);
    assert.strictEqual(r.applied.fromTheirs, 1);
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
