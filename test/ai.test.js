/**
 * Tests for the one piece of the AI edit that is pure and worth pinning:
 * pulling the XML out of a model response. The model is told to return only
 * the document, but they wrap it in fences and add a friendly sentence often
 * enough that trusting the raw text would fail on perfectly good output.
 *
 * The network call and the parse-or-reject gate are exercised by hand; this
 * is the deterministic extraction. Plain `node test/ai.test.js`.
 */

'use strict';

const assert = require('assert');
const { extractXml, assertOpenable } = require('../menu/ai-service');
const { parse } = require('../menu/diagram-diff-service');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}
async function testAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';
const wrap = inner => `<?xml version="1.0"?><bpmn:definitions ${NS} targetNamespace="x"><bpmn:process id="P">${inner}</bpmn:process></bpmn:definitions>`;

const DOC = '<?xml version="1.0"?><bpmn:definitions><bpmn:process id="P"/></bpmn:definitions>';

test('plain document is returned as-is', () => {
  assert.strictEqual(extractXml(DOC), DOC);
});

test('a ```xml fence is stripped', () => {
  assert.strictEqual(extractXml('```xml\n' + DOC + '\n```'), DOC);
});

test('a bare ``` fence is stripped', () => {
  assert.strictEqual(extractXml('```\n' + DOC + '\n```'), DOC);
});

test('a friendly sentence before the document is dropped', () => {
  assert.strictEqual(extractXml('Sure! Here is the updated diagram:\n\n' + DOC), DOC);
});

test('a document starting at <definitions without a prolog is kept', () => {
  const noProlog = '<definitions xmlns="x"><process id="P"/></definitions>';
  assert.strictEqual(extractXml('Here:\n' + noProlog), noProlog);
});

test('surrounding whitespace is trimmed', () => {
  assert.strictEqual(extractXml('\n\n  ' + DOC + '  \n'), DOC);
});

async function run() {
  await testAsync('assertOpenable accepts a fully-connected flow', async () => {
    const root = await parse(wrap(
      '<bpmn:task id="A"/><bpmn:task id="B"/>' +
      '<bpmn:sequenceFlow id="F" sourceRef="A" targetRef="B"/>'));
    assert.doesNotThrow(() => assertOpenable(root));
  });

  await testAsync('assertOpenable rejects a flow with no target (the Modeler crash)', async () => {
    const root = await parse(wrap(
      '<bpmn:task id="A"/><bpmn:sequenceFlow id="F" sourceRef="A"/>'));
    assert.throws(() => assertOpenable(root), /no target/);
  });

  await testAsync('assertOpenable rejects a flow with no source', async () => {
    const root = await parse(wrap(
      '<bpmn:task id="B"/><bpmn:sequenceFlow id="F" targetRef="B"/>'));
    assert.throws(() => assertOpenable(root), /no source/);
  });

  const failed = results.filter(r => !r.ok);
  results.forEach(r => {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok) console.log(`     ${r.err.message}`);
  });
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

run();
