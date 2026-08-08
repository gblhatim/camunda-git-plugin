/**
 * Tests for the panel's translations.
 *
 * The dictionary is a plain object literal, so a duplicated key is not an
 * error - the second one silently wins and the first translation vanishes.
 * That is the failure this file exists to catch, along with the two other
 * ways a translation goes quietly wrong: a placeholder that does not survive
 * into the French, and an entry that was never translated at all.
 *
 * The dictionary is read as text rather than imported: client/i18n.js is an
 * ES module bundled for the renderer, and this runs under plain node.
 *
 * Plain `node test/i18n.test.js`.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

const source = fs.readFileSync(
  path.join(__dirname, '..', 'client', 'i18n.js'), 'utf8'
);

const body = source.slice(
  source.indexOf('const FR = {'),
  source.indexOf('const DICTIONARIES')
);

// Key and value of each entry. Values may run onto the next line, so the
// value side is matched lazily up to the line that ends the entry.
const ENTRY = new RegExp(
  "^\\s*'((?:[^'\\\\]|\\\\.)+)':\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'",
  'gm'
);

const entries = [];
let m;
while ((m = ENTRY.exec(body))) {
  entries.push({ en: m[1], fr: m[2] });
}

test('the dictionary parses into entries at all', () => {
  assert.ok(entries.length > 200, `only found ${entries.length} entries`);
});

test('no duplicate keys - a second one would silently replace the first', () => {
  const seen = new Set();
  const dupes = [];

  entries.forEach(e => {
    if (seen.has(e.en)) dupes.push(e.en);
    seen.add(e.en);
  });

  assert.deepStrictEqual(dupes, [], `duplicated: ${dupes.join(' | ')}`);
});

test('no entry was left as its own English', () => {
  // A key copied to the value side is the signature of a half-finished pass.
  // Proper nouns that are the same in both languages are the exception.
  const SAME_IN_BOTH = new Set([ 'GitLab host', 'API key' ]);

  const untranslated = entries
    .filter(e => e.en === e.fr && !SAME_IN_BOTH.has(e.en))
    .map(e => e.en);

  assert.deepStrictEqual(untranslated, [],
    `untranslated: ${untranslated.join(' | ')}`);
});

test('every placeholder in the English survives into the French', () => {
  const placeholders = s => (s.match(/\{[a-z]+\}/g) || []).sort();
  const broken = [];

  entries.forEach(e => {
    const en = placeholders(e.en);
    const fr = placeholders(e.fr);

    // A dropped {name} renders the sentence with the value missing, which
    // reads as a bug rather than as a translation.
    if (en.join(',') !== fr.join(',')) {
      broken.push(`${e.en}  [en: ${en.join(',')} | fr: ${fr.join(',')}]`);
    }
  });

  assert.deepStrictEqual(broken, [], broken.join('\n     '));
});

test('no French value is empty', () => {
  const empty = entries.filter(e => !e.fr.trim()).map(e => e.en);
  assert.deepStrictEqual(empty, []);
});

test('the language ids agree with what settings-service will store', () => {
  const settings = require('../menu/settings-service');
  const inPanel = [];
  const ID = /id: '([a-z]{2})'/g;
  let found;
  while ((found = ID.exec(source))) inPanel.push(found[1]);

  // The two lists are maintained by hand - the renderer is bundled
  // separately and cannot require the service - so this is the only thing
  // keeping them honest.
  assert.deepStrictEqual(inPanel.sort(), settings.LANGUAGES.slice().sort());
});

const failed = results.filter(r => !r.ok);
results.forEach(r => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok) console.log(`     ${r.err.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
