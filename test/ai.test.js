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
const { extractXml } = require('../menu/ai-service');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

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

const failed = results.filter(r => !r.ok);
results.forEach(r => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok) console.log(`     ${r.err.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
