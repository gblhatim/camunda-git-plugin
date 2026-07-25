/**
 * Find identifiers that are used but never declared, imported, or global.
 *
 * Exists because of a real bug: `ConflictResolver` called a `humanizeBranch`
 * that was never defined anywhere. Webpack bundles a free variable happily -
 * it becomes a lookup on the global object - so the build was green and the
 * panel threw `humanizeBranch is not defined` only once a merge was actually
 * in progress. That is the worst possible moment for the panel to die, and
 * nothing in the toolchain was ever going to catch it: there is no linter
 * here, and the renderer has no tests.
 *
 * This is not a linter. It answers one question, the one that broke:
 * does every identifier resolve to something?
 *
 *   node scripts/check-undefined.js
 *
 * Exits non-zero when anything is unresolved, so it can gate a build.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// Browser and language globals the renderer legitimately reaches for.
const GLOBALS = new Set([
  'console', 'window', 'document', 'navigator', 'location', 'fetch',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'Intl', 'Proxy', 'Reflect', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN',
  'Infinity', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'URL', 'URLSearchParams', 'Blob', 'FormData', 'AbortController',
  'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'globalThis',
  'process', 'structuredClone', 'TextEncoder', 'TextDecoder'
]);

const targets = process.argv.slice(2);

const files = targets.length ? targets : [
  'client/index.js',
  'client/components.js',
  'client/history.js',
  'client/icons.js',
  'client/task-details.js'
];

let problems = 0;

files.forEach(file => {
  const full = path.resolve(file);

  let ast;

  try {
    ast = parser.parse(fs.readFileSync(full, 'utf8'), {
      sourceType: 'module',
      plugins: [ 'jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator' ]
    });
  } catch (err) {
    console.error(`${file}: could not parse - ${err.message}`);
    problems++;
    return;
  }

  const seen = new Set();

  traverse(ast, {
    ReferencedIdentifier(nodePath) {
      const { name } = nodePath.node;

      if (GLOBALS.has(name) || seen.has(name)) {
        return;
      }

      // `hasBinding` walks out to the program scope, so this covers
      // imports, function declarations, consts and parameters alike.
      if (nodePath.scope.hasBinding(name, true)) {
        return;
      }

      seen.add(name);
      problems++;

      const line = nodePath.node.loc ? nodePath.node.loc.start.line : '?';
      console.error(`${file}:${line}  "${name}" is not defined, imported, or a known global`);
    }
  });
});

if (problems) {
  console.error(`\n${problems} unresolved identifier(s).`);
  process.exit(1);
}

console.log(`No unresolved identifiers in ${files.length} file(s).`);
