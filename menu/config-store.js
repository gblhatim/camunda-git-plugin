/**
 * Config for the plugin, in two places on purpose.
 *
 * 1. `~/.camunda-git-plugin/config.json` - this computer, this person.
 *    Which repo is open, tokens, auto-pull, vocabulary. Kept outside the
 *    plugin folder so it survives reinstalls and never gets committed if
 *    someone versions their `plugins` directory.
 *
 * 2. `<repo>/.camunda-git.json` - the *team's* settings, committed to the
 *    repository. Branch model, naming, merge policy.
 *
 * The split is the point. Analysts and developers work in the same repo, so
 * "which branch do features start from" cannot be a per-machine guess: two
 * people resolving it differently produces an incoherent branch layout that
 * nobody notices until merge time. Anything that must agree across the team
 * lives in the committed file; anything personal stays local.
 *
 * The local file is keyed by repository path. It used to be a single flat
 * object, which meant one `mergePolicy` and one `autoPull` for every
 * project on the machine - invisible to an analyst with one folder, wrong
 * immediately for a developer with five. `migrate()` moves that shape
 * forward on first read.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.camunda-git-plugin');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Committed to the repository, alongside the diagrams it describes.
const SHARED_FILENAME = '.camunda-git.json';

const SCHEMA_VERSION = 2;

// Keys that belong to the person and the machine, not the project.
// `developerMode` is here rather than per-repo on purpose: it is a fact
// about the person sitting at the machine, not about the project. An
// analyst opening a developer's repo must not inherit their console.
const GLOBAL_KEYS = [
  'repoPath', 'githubToken', 'gitlabToken', 'vocabulary', 'developerMode',
  'openRouterKey', 'openRouterModel'
];

// Keys that are per-project but still personal - how often *I* want to pull.
const REPO_KEYS = [ 'autoPull', 'gitlabHost' ];

// Keys that must agree across the whole team, so they live in the repo.
const SHARED_KEYS = [
  'branchModel', 'baseBranch', 'releaseBranch', 'branchPrefixes',
  'mergePolicy', 'jiraHost', 'jiraProjectKey'
];

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Repository paths are the key of the per-repo map, so they have to compare
 * equal however the user typed them. Windows paths are case-insensitive;
 * POSIX ones are not.
 */
function repoKey(repoPath) {
  if (!repoPath) {
    return '';
  }

  const resolved = path.resolve(repoPath);

  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Bring a v1 (flat) config forward: personal keys stay at the top level,
 * project keys move under the repo they were describing.
 *
 * Shared keys are deliberately *not* moved into the repo file here. Writing
 * to someone's working tree as a side effect of reading config would be a
 * surprise, and it could dirty a clean checkout at startup. They are kept
 * under the repo entry as a fallback until the team writes a real one.
 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') {
    return { version: SCHEMA_VERSION, global: {}, repos: {} };
  }

  if (raw.version === SCHEMA_VERSION && raw.repos) {
    return raw;
  }

  const next = { version: SCHEMA_VERSION, global: {}, repos: {} };

  GLOBAL_KEYS.forEach(key => {
    if (raw[key] !== undefined) next.global[key] = raw[key];
  });

  const key = repoKey(raw.repoPath);

  if (key) {
    const entry = {};

    REPO_KEYS.concat(SHARED_KEYS).forEach(k => {
      if (raw[k] !== undefined) entry[k] = raw[k];
    });

    if (Object.keys(entry).length) {
      next.repos[key] = entry;
    }
  }

  return next;
}

function readRaw() {
  ensureDir();

  if (!fs.existsSync(CONFIG_FILE)) {
    return { version: SCHEMA_VERSION, global: {}, repos: {} };
  }

  try {
    return migrate(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    console.error('[camunda-git-plugin] failed to read config, resetting.', err);
    return { version: SCHEMA_VERSION, global: {}, repos: {} };
  }
}

function writeRaw(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ------------------------------------------------------------------ shared

function sharedFilePath(repoPath) {
  return repoPath ? path.join(repoPath, SHARED_FILENAME) : null;
}

// readConfig() runs on every status poll, so a repo with a broken team file
// would otherwise log the same parse error every few seconds forever. Warn
// once per file, and again only if the file changes.
const warnedShared = new Map();

function warnOnce(file, message) {
  let stamp = null;

  try {
    stamp = String(fs.statSync(file).mtimeMs);
  } catch (err) { /* unreadable; warn once per path */ }

  if (warnedShared.get(file) === stamp) {
    return;
  }

  warnedShared.set(file, stamp);
  console.error(`[camunda-git-plugin] ${message}`);
}

/**
 * The team's settings, from the committed file. Missing or malformed is a
 * normal state - a repo that predates this plugin has no such file - so it
 * degrades to `{}` and lets the caller apply defaults.
 */
function readShared(repoPath) {
  const file = sharedFilePath(repoPath);

  if (!file || !fs.existsSync(file)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shared = {};

    SHARED_KEYS.forEach(key => {
      if (parsed[key] !== undefined) shared[key] = parsed[key];
    });

    warnedShared.delete(file);

    return shared;
  } catch (err) {
    warnOnce(file, `${SHARED_FILENAME} is not valid JSON, ignoring it: ${err.message}`);
    return {};
  }
}

/**
 * Write the team's settings into the working tree. The caller is expected
 * to have asked first: this dirties the repo, and the user then has to
 * commit it like any other change.
 */
function writeShared(repoPath, patch) {
  const file = sharedFilePath(repoPath);

  if (!file) {
    throw new Error('No project folder is selected, so there is nowhere to save team settings.');
  }

  const next = Object.assign({}, readShared(repoPath), patch);

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');

  return next;
}

// ----------------------------------------------------------------- reading

/**
 * A flat view of everything that applies to the currently selected repo:
 * personal keys, this repo's personal keys, then the team's committed
 * settings on top.
 *
 * Team settings win because that is what they are for - if the repo says
 * features branch off `develop`, a stale local value must not quietly
 * override it. The per-repo entry still carries the pre-migration values,
 * so a project with no committed file behaves exactly as it did before.
 */
function readConfig() {
  const raw = readRaw();
  const global = raw.global || {};
  const key = repoKey(global.repoPath);
  const repo = (key && raw.repos[key]) || {};

  return Object.assign({}, global, repo, readShared(global.repoPath));
}

/**
 * Per-repo settings without the merge, for a repo other than the active
 * one. Used when switching projects.
 */
function readRepo(repoPath) {
  const raw = readRaw();
  const key = repoKey(repoPath);

  return (key && raw.repos[key]) || {};
}

// ----------------------------------------------------------------- writing

function updateGlobal(patch) {
  const raw = readRaw();

  raw.global = Object.assign({}, raw.global, patch);
  writeRaw(raw);

  return raw.global;
}

function updateRepo(repoPath, patch) {
  const key = repoKey(repoPath);

  if (!key) {
    throw new Error('No project folder is selected, so there is nothing to save against.');
  }

  const raw = readRaw();

  raw.repos[key] = Object.assign({}, raw.repos[key], patch);
  writeRaw(raw);

  return raw.repos[key];
}

/**
 * Back-compatible entry point: routes each key to wherever it now lives.
 *
 * Callers written against the old flat store keep working, and there is one
 * place that knows the routing rather than every caller having to.
 */
function update(patch = {}) {
  const globalPatch = {};
  const repoPatch = {};
  const sharedPatch = {};

  Object.keys(patch).forEach(key => {
    if (GLOBAL_KEYS.includes(key)) {
      globalPatch[key] = patch[key];
    } else if (SHARED_KEYS.includes(key)) {
      sharedPatch[key] = patch[key];
    } else if (REPO_KEYS.includes(key)) {
      repoPatch[key] = patch[key];
    }
    // Unknown keys are dropped, as before: a malformed request must not be
    // able to write arbitrary config.
  });

  if (Object.keys(globalPatch).length) {
    updateGlobal(globalPatch);
  }

  // Read *after* the global patch: it may have just changed which repo is
  // active, and the rest of this update belongs to the new one.
  const repoPath = readRaw().global.repoPath;

  if (Object.keys(repoPatch).length && repoPath) {
    updateRepo(repoPath, repoPatch);
  }

  if (Object.keys(sharedPatch).length && repoPath) {
    // Until the team file exists, shared values are held in the local repo
    // entry so nothing is silently lost. writeShared() is an explicit act.
    updateRepo(repoPath, sharedPatch);
  }

  return readConfig();
}

module.exports = {
  CONFIG_FILE,
  SHARED_FILENAME,
  SCHEMA_VERSION,
  GLOBAL_KEYS,
  REPO_KEYS,
  SHARED_KEYS,
  repoKey,
  migrate,
  readRaw,
  writeRaw,
  readConfig,
  readRepo,
  readShared,
  writeShared,
  updateGlobal,
  updateRepo,
  update
};
