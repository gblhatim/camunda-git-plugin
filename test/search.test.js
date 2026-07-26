/**
 * Tests for the semantic search matching.
 *
 * The file walk and mtime cache need a real repo, so those are covered by
 * hand elsewhere; what matters here is the part that decides whether an
 * element matches a query - across names, types, and the `camunda:*`
 * configuration a raw grep never sees. Each case parses a tiny diagram,
 * builds the same searchables the service does, and checks the query.
 *
 * Plain `node test/search.test.js`.
 */

'use strict';

const assert = require('assert');

const { parse } = require('../menu/diagram-diff-service');
const { searchablesOf, matchElement, parseQuery } = require('../menu/search-service');

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';

const XML =
  `<?xml version="1.0"?>
<bpmn:definitions ${NS} targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:userTask id="U" name="Approve invoice" camunda:assignee="jdoe" camunda:candidateGroups="finance" />
    <bpmn:serviceTask id="S" name="Charge card" camunda:delegateExpression="\${paymentAdapter}" />
    <bpmn:callActivity id="C" name="Run sub" calledElement="InvoiceProcess" />
    <bpmn:intermediateCatchEvent id="E" name="Wait">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT5M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
  </bpmn:process>
</bpmn:definitions>`;

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

let elems;

// Which element ids match a query.
function idsFor(query) {
  const tokens = parseQuery(query);
  return elems.filter(s => matchElement(s, tokens).ok).map(s => s.id).sort();
}

async function run() {
  elems = searchablesOf(await parse(XML));

  await test('parseQuery splits fields, bare terms, and keeps ${} intact', () => {
    assert.deepStrictEqual(parseQuery('approve'), [ { field: null, value: 'approve' } ]);
    assert.deepStrictEqual(parseQuery('assignee:jdoe'), [ { field: 'assignee', value: 'jdoe' } ]);
    // A ${...} expression is a value, not a field:value.
    assert.deepStrictEqual(parseQuery('${paymentAdapter}'),
      [ { field: null, value: '${paymentadapter}' } ]);
  });

  await test('bare term matches an element name', () => {
    assert.deepStrictEqual(idsFor('approve'), [ 'U' ]);
  });

  await test('bare term matches configuration a raw grep would miss (assignee)', () => {
    assert.deepStrictEqual(idsFor('jdoe'), [ 'U' ]);
  });

  await test('field filter: assignee:jdoe', () => {
    assert.deepStrictEqual(idsFor('assignee:jdoe'), [ 'U' ]);
  });

  await test('field alias: calls:Invoice finds the call activity', () => {
    assert.deepStrictEqual(idsFor('calls:invoice'), [ 'C' ]);
  });

  await test('field alias: delegate:paymentAdapter finds the service task', () => {
    assert.deepStrictEqual(idsFor('delegate:paymentadapter'), [ 'S' ]);
  });

  await test('field alias: group:finance', () => {
    assert.deepStrictEqual(idsFor('group:finance'), [ 'U' ]);
  });

  await test('a timer is found by the word timer, though nothing is named that', () => {
    assert.deepStrictEqual(idsFor('timer'), [ 'E' ]);
    assert.deepStrictEqual(idsFor('pt5m'), [ 'E' ]);
  });

  await test('type: filter', () => {
    assert.deepStrictEqual(idsFor('type:serviceTask'), [ 'S' ]);
  });

  await test('multiple tokens are AND', () => {
    // "card" (name) AND a delegate expression -> only the service task.
    assert.deepStrictEqual(idsFor('card delegate:payment'), [ 'S' ]);
    // A term that no single element satisfies together yields nothing.
    assert.deepStrictEqual(idsFor('approve delegate:payment'), []);
  });

  await test('assignee: with no value means "has an assignee at all"', () => {
    assert.deepStrictEqual(idsFor('assignee:'), [ 'U' ]);
  });

  await test('the matched property is reported as the reason', () => {
    const u = elems.find(s => s.id === 'U');
    const { ok, reasons } = matchElement(u, parseQuery('assignee:jdoe'));
    assert.ok(ok);
    assert.ok(reasons.some(r => /assignee/i.test(r.label) && r.value === 'jdoe'));
  });

  // ---- report ----
  const failed = results.filter(r => !r.ok);
  results.forEach(r => {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok) console.log(`     ${r.err.message}`);
  });
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

run();
