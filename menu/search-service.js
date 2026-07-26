/**
 * Search across every diagram in the project - semantically, not as text.
 *
 * A raw grep of `.bpmn` files is close to useless: the things worth finding
 * - who a task is assigned to, which delegate a service task calls, how long
 * a timer runs - live in `camunda:*` attributes and inside extension
 * elements, under ids and namespaces nobody remembers. `diagram-diff-service`
 * already knows how to flatten an element into `{ label -> value }` with
 * human names (it is how the diff reads configuration); this reuses exactly
 * that, over the whole corpus, so "find every task assigned to jdoe" or
 * "everything that calls InvoiceProcess" is one query rather than opening
 * forty diagrams.
 *
 * Parsing every file on every keystroke would not scale, so each file is
 * indexed once and cached against its mtime; only what changed on disk is
 * reparsed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gitService = require('./git-service');
const fileService = require('./file-service');
const {
  parse, indexElements, ownProperties, labelFor
} = require('./diagram-diff-service');

// Convenience field names people reach for, mapped to the substring that
// actually appears in a property's label or key. Anything not listed still
// works - the field is matched against labels and keys directly - these just
// make the common ones forgiving.
const FIELD_ALIASES = {
  calls: 'called',
  call: 'called',
  group: 'candidate group',
  groups: 'candidate group',
  user: 'candidate user',
  assignee: 'assignee',
  delegate: 'delegate',
  expression: 'expression',
  class: 'class',
  form: 'form',
  timer: 'timer',
  due: 'due',
  message: 'message',
  signal: 'signal',
  error: 'error',
  decision: 'decision',
  topic: 'topic',
  doc: 'documentation'
};

function typeOf(element) {
  return String(element.$type || '').replace(/^[a-z]+:/i, '');
}

function nameOf(element) {
  return element.name || (element.$attrs && element.$attrs.name) || null;
}

/**
 * One element reduced to what a search needs: its name, type, its
 * configuration as labelled rows, and a single lowercased blob to test bare
 * terms against.
 */
function searchableOf(element) {
  const id = element.id;
  const name = nameOf(element);
  const type = typeOf(element);

  const props = Object.entries(ownProperties(element)).map(([ key, value ]) => ({
    key,
    label: labelFor(key),
    value: String(value)
  }));

  const blob = [
    name || '', type,
    ...props.map(p => `${p.label} ${p.key} ${p.value}`)
  ].join('  ').toLowerCase();

  return { id, name, type, props, blob };
}

/**
 * Every searchable element of one diagram. DI and elements without an id are
 * skipped by `indexElements` already.
 */
function searchablesOf(root) {
  const out = [];
  indexElements(root).forEach(element => out.push(searchableOf(element)));
  return out;
}

/**
 * A query into tokens. `assignee:jdoe` is a field token; a bare `approve`
 * matches anywhere. Quotes keep a phrase together.
 */
function parseQuery(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const parts = text.match(/"[^"]+"|\S+/g) || [];

  return parts.map(part => {
    const bare = part.replace(/^"|"$/g, '');
    const colon = bare.indexOf(':');

    // A colon after a field name is a filter (`assignee:jdoe`, or a trailing
    // `assignee:` meaning "has one at all"). An expression like `${x}` starts
    // with the brace, so it stays a bare term rather than a "field".
    if (colon > 0 && !/^\$\{/.test(bare)) {
      return {
        field: bare.slice(0, colon).toLowerCase(),
        value: bare.slice(colon + 1).replace(/^"|"$/g, '').toLowerCase()
      };
    }

    return { field: null, value: bare.toLowerCase() };
  });
}

function propMatchesField(prop, field, value) {
  const target = FIELD_ALIASES[field] || field;
  const inField = prop.label.toLowerCase().includes(target) ||
    prop.key.toLowerCase().includes(target);

  if (!inField) return false;

  // `assignee:` with no value asks "does it have an assignee at all".
  return !value || prop.value.toLowerCase().includes(value);
}

/**
 * Whether one element satisfies every token (AND), and which properties are
 * worth showing as the reason it matched.
 */
function matchElement(s, tokens) {
  const reasons = new Set();

  const ok = tokens.every(token => {
    if (!token.field) {
      if (s.blob.includes(token.value)) {
        s.props.forEach(p => {
          if (p.value.toLowerCase().includes(token.value) ||
              p.label.toLowerCase().includes(token.value)) {
            reasons.add(p);
          }
        });
        return true;
      }
      return false;
    }

    if (token.field === 'type') return s.type.toLowerCase().includes(token.value);
    if (token.field === 'name') return (s.name || '').toLowerCase().includes(token.value);
    if (token.field === 'id') return s.id.toLowerCase().includes(token.value);

    const hit = s.props.find(p => propMatchesField(p, token.field, token.value));
    if (hit) { reasons.add(hit); return true; }
    return false;
  });

  return { ok, reasons: Array.from(reasons) };
}

// path -> { mtimeMs, elements }
const cache = new Map();

async function indexFile(absPath, relPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    cache.delete(relPath);
    return null;
  }

  const cached = cache.get(relPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.elements;
  }

  let elements = null;

  try {
    const xml = fs.readFileSync(absPath, 'utf8');
    const root = await parse(xml);
    elements = searchablesOf(root);
  } catch (err) {
    elements = null;   // unparseable - still findable by filename below
  }

  cache.set(relPath, { mtimeMs: stat.mtimeMs, elements });
  return elements;
}

function baseName(relPath) {
  return relPath.split('/').pop();
}

function filenameMatches(relPath, tokens) {
  const name = baseName(relPath).toLowerCase();
  // Only bare terms match a filename; a field filter is about configuration.
  return tokens.every(t => t.field ? false : name.includes(t.value)) &&
    tokens.some(t => !t.field);
}

/**
 * Search the whole project. Returns groups by file, conflicting-free and
 * capped so an over-broad query cannot flood the panel.
 */
async function search(rawQuery, { limit = 300, perFile = 40 } = {}) {
  const tokens = parseQuery(rawQuery);

  if (!tokens.length) {
    return { query: '', groups: [], totalHits: 0, filesSearched: 0, truncated: false };
  }

  const repoPath = gitService.getRepoPath();
  const files = (await fileService.listFiles({ diagramsOnly: true })).sort();

  const groups = [];
  let totalHits = 0;
  let filesSearched = 0;
  let truncated = false;

  for (const rel of files) {
    if (totalHits >= limit) { truncated = true; break; }

    const isBpmn = /\.bpmn$/i.test(rel);
    const elements = isBpmn ? await indexFile(path.join(repoPath, rel), rel) : null;

    filesSearched += 1;

    const hits = [];

    if (elements) {
      for (const s of elements) {
        const { ok, reasons } = matchElement(s, tokens);
        if (ok) {
          hits.push({
            id: s.id,
            name: s.name,
            type: s.type,
            matches: reasons.slice(0, 4).map(p => ({ label: p.label, value: p.value }))
          });
          if (hits.length >= perFile) break;
        }
      }
    }

    // A file with no element hits is still worth returning if its own name
    // matches - which is also the only way .dmn/.form (not BPMN) show up.
    if (hits.length || filenameMatches(rel, tokens)) {
      groups.push({
        path: rel,
        name: baseName(rel),
        isDiagram: true,
        hitCount: hits.length,
        matchedName: !hits.length,
        hits
      });
      totalHits += hits.length || 1;
    }
  }

  return { query: rawQuery.trim(), groups, totalHits, filesSearched, truncated };
}

module.exports = {
  search,
  parseQuery,
  matchElement,
  searchableOf,
  searchablesOf
};
