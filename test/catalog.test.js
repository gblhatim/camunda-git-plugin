/**
 * The catalog ships .bpmn files that must open cleanly in Modeler, so this
 * checks each one: it is listed, it parses as BPMN, it carries diagram
 * layout (a BPMNPlane with shapes - a file with no DI opens blank), and the
 * summary the cards show is non-empty. Catches a hand-authored pattern that
 * would look broken the moment someone clicks it.
 *
 * Plain `node test/catalog.test.js`.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { readIndex, summarize } = require('../menu/catalog-service');
const { parse } = require('../menu/diagram-diff-service');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

async function run() {
  const index = readIndex();

  await test('the index lists at least a few patterns', () => {
    assert.ok(Array.isArray(index) && index.length >= 3, 'expected several entries');
  });

  await test('every entry has id, title, description and a file', () => {
    index.forEach(e => {
      assert.ok(e.id && e.title && e.description && e.file, `incomplete entry: ${JSON.stringify(e)}`);
    });
  });

  for (const entry of index) {
    await test(`${entry.id}: the file exists`, () => {
      assert.ok(fs.existsSync(path.join(CATALOG_DIR, entry.file)), `missing ${entry.file}`);
    });

    await test(`${entry.id}: parses as BPMN`, async () => {
      const xml = fs.readFileSync(path.join(CATALOG_DIR, entry.file), 'utf8');
      await assert.doesNotReject(parse(xml), `${entry.file} did not parse`);
    });

    await test(`${entry.id}: has diagram layout (a BPMNPlane with shapes)`, () => {
      const xml = fs.readFileSync(path.join(CATALOG_DIR, entry.file), 'utf8');
      assert.ok(/BPMNPlane/.test(xml), `${entry.file} has no BPMNPlane`);
      assert.ok(/BPMNShape/.test(xml), `${entry.file} has no shapes - it would open blank`);
    });

    await test(`${entry.id}: summarises to a non-empty element list`, async () => {
      const xml = fs.readFileSync(path.join(CATALOG_DIR, entry.file), 'utf8');
      const els = await summarize(xml);
      assert.ok(els.length > 0, `${entry.file} summarised to nothing`);
    });
  }

  const failed = results.filter(r => !r.ok);
  results.forEach(r => {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok) console.log(`     ${r.err.message}`);
  });
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

run();
