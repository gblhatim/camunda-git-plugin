/**
 * The diagram explorer's data source.
 *
 * Files come from `git ls-files` rather than a filesystem walk, so
 * .gitignore is respected for free and node_modules-sized directories are
 * never traversed. Untracked files are included explicitly - a diagram
 * someone just created is exactly the one they are looking for.
 */

'use strict';

const path = require('path');

const gitService = require('./git-service');

const DIAGRAM_EXTENSIONS = /\.(bpmn|dmn|form)$/i;

/**
 * Every file git knows about, tracked or not, excluding ignored ones.
 */
async function listFiles({ diagramsOnly = true } = {}) {
  const git = gitService.getGit();

  const raw = await git.raw([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard'
  ]);

  const all = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // `ls-files` can list the same path twice (cached *and* other).
  const unique = Array.from(new Set(all));

  return diagramsOnly
    ? unique.filter(f => DIAGRAM_EXTENSIONS.test(f))
    : unique;
}

/**
 * Build a folder tree, annotated with each file's git status so the
 * explorer can badge changed diagrams without a second lookup.
 *
 * Folders that contain a single folder and nothing else are collapsed
 * ("src/main/resources" rather than three nested rows), which matters a
 * lot in the deep directory layouts BPMN projects tend to have.
 */
async function getTree({ diagramsOnly = true } = {}) {
  const [ files, { status } ] = await Promise.all([
    listFiles({ diagramsOnly }),
    gitService.getStatus()
  ]);

  const statusByPath = new Map();

  status.files.forEach(f => {
    statusByPath.set(f.path, {
      index: f.index,
      working_dir: f.working_dir,
      staged: f.staged
    });
  });

  const root = { name: '', path: '', folders: new Map(), files: [] };

  files.forEach(filePath => {
    const parts = filePath.split('/');
    const fileName = parts.pop();

    let node = root;

    parts.forEach(part => {
      if (!node.folders.has(part)) {
        node.folders.set(part, {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          folders: new Map(),
          files: []
        });
      }
      node = node.folders.get(part);
    });

    const fileStatus = statusByPath.get(filePath) || null;

    node.files.push({
      name: fileName,
      title: fileName.replace(DIAGRAM_EXTENSIONS, ''),
      path: filePath,
      extension: (path.extname(fileName) || '').replace('.', '').toLowerCase(),
      status: fileStatus,
      changed: !!fileStatus
    });
  });

  function serialize(node) {
    const folders = Array.from(node.folders.values())
      .map(serialize)
      .sort((a, b) => a.name.localeCompare(b.name));

    const serialized = {
      name: node.name,
      path: node.path,
      folders,
      files: node.files.sort((a, b) => a.title.localeCompare(b.title))
    };

    // Collapse a chain of single-child folders into one row.
    if (!serialized.files.length && folders.length === 1 && node.name) {
      const only = folders[0];
      return {
        name: `${node.name}/${only.name}`,
        path: only.path,
        folders: only.folders,
        files: only.files
      };
    }

    return serialized;
  }

  const tree = serialize(root);

  return {
    // The renderer opens files with triggerAction('open-diagram', { path }),
    // which needs an absolute path - so it gets the repo root to join with.
    repoPath: gitService.getRepoPath(),
    total: files.length,
    changed: files.filter(f => statusByPath.has(f)).length,
    tree
  };
}

module.exports = {
  listFiles,
  getTree,
  DIAGRAM_EXTENSIONS
};
