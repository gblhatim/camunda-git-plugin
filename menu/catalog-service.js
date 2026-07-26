/**
 * The catalog: a shipped set of ready-made BPMN patterns to copy or start
 * from, so common shapes - an approval, a retry loop, a parallel review -
 * do not have to be drawn from scratch every time.
 *
 * The diagrams live as ordinary `.bpmn` files under `catalog/`, described by
 * `catalog/index.json`. They are read from the plugin folder, never the
 * user's repo, so the catalog is available before any project is set up.
 * Only "start a new diagram from this" touches the repo, and it only ever
 * *adds* a file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gitService = require('./git-service');
const { parse, indexElements } = require('./diagram-diff-service');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

// Container and connector types are structure, not the "what is in here"
// summary a reader wants; dropping them leaves the activities and events.
const SKIP_TYPE = /(?:Definitions|Process|Collaboration|Participant|SequenceFlow|MessageFlow|Lane|LaneSet)$/;

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'index.json'), 'utf8'));
}

function readXml(entry) {
  return fs.readFileSync(path.join(CATALOG_DIR, entry.file), 'utf8');
}

/**
 * A readable element list for a card - "Start event, User task 'Review
 * request', Exclusive gateway 'Approved?'" - parsed from the diagram rather
 * than hand-written, so it cannot drift from the file.
 */
async function summarize(xml) {
  try {
    const root = await parse(xml);
    const out = [];

    indexElements(root).forEach(element => {
      const type = String(element.$type || '').replace(/^bpmn:/, '');
      if (SKIP_TYPE.test(type)) return;

      out.push({ type, name: element.name || null });
    });

    return out;
  } catch (err) {
    return [];
  }
}

async function list() {
  const entries = readIndex();

  const withDetail = await Promise.all(entries.map(async entry => {
    const xml = readXml(entry);

    return {
      id: entry.id,
      title: entry.title,
      category: entry.category,
      description: entry.description,
      xml,
      elements: await summarize(xml)
    };
  }));

  return { entries: withDetail };
}

function findEntry(id) {
  const entry = readIndex().find(e => e.id === id);

  if (!entry) {
    throw new Error(`No catalog entry "${id}".`);
  }

  return entry;
}

function slugify(text) {
  return String(text || 'diagram')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'diagram';
}

/**
 * Write a catalog pattern into the repo as a new, unique `.bpmn` file and
 * return its repo-relative path so the caller can open it. Never overwrites:
 * a name clash gets a numbered suffix.
 */
async function createDiagram({ id, name }) {
  const entry = findEntry(id);
  const xml = readXml(entry);
  const repo = gitService.getRepoPath();

  const base = slugify(name || entry.title);

  let rel = `${base}.bpmn`;
  let n = 1;

  while (fs.existsSync(path.join(repo, rel))) {
    rel = `${base}-${n}.bpmn`;
    n += 1;
  }

  gitService.assertSafeRelativePath(rel);
  fs.writeFileSync(path.join(repo, rel), xml, 'utf8');

  return { path: rel, name: path.basename(rel) };
}

/**
 * One entry's title and full XML, for the preview window.
 */
function getEntry(id) {
  const entry = findEntry(id);
  return { id: entry.id, title: entry.title, xml: readXml(entry) };
}

module.exports = {
  list,
  getEntry,
  createDiagram,
  readIndex,
  summarize
};
