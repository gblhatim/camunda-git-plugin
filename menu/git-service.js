/**
 * Thin wrapper around `simple-git`, scoped to the repo path the user
 * configures once via "Git: Repository Settings...".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const configStore = require('./config-store');
const commandLog = require('./command-log');

function getRepoPath() {
  const config = configStore.readConfig();

  if (!config.repoPath) {
    throw new Error(
      'No repository configured yet. Use "Git: Repository Settings..." first.'
    );
  }

  return config.repoPath;
}

function getGit() {
  // Every git call goes through the log - see menu/command-log.js.
  return commandLog.instrument(simpleGit(getRepoPath()));
}

/**
 * The real git directory.
 *
 * `.git` is a directory in an ordinary clone but a *file* pointing
 * elsewhere in a worktree or submodule, and several things here read state
 * files out of it.
 */
function gitDir() {
  const repo = getRepoPath();
  const dotGit = path.join(repo, '.git');

  try {
    if (fs.statSync(dotGit).isDirectory()) {
      return dotGit;
    }

    const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);

    if (pointer) {
      const target = pointer[1].trim();
      return path.isAbsolute(target) ? target : path.join(repo, target);
    }
  } catch (err) {
    // No repository, or unreadable - callers treat that as "nothing there",
    // which is the safe reading.
  }

  return dotGit;
}

/**
 * What HEAD points at, read from the refs rather than by running git.
 *
 * This is on the status poll, which runs every few seconds, so it matters
 * that it is cheap - but the reason it does not shell out is correctness,
 * not speed. `git rev-parse HEAD` *fails* on a repository with no commits
 * ("ambiguous argument 'HEAD'"), which is a perfectly normal state on a
 * brand new project. Polling it there put a red failed command in the
 * Activity log every five seconds, on the one screen whose whole job is to
 * make the plugin's behaviour legible.
 *
 * Returns null when there is no commit yet, which is an answer, not a
 * failure.
 */
function readHeadSha() {
  const dir = gitDir();

  let head;

  try {
    head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
  } catch (err) {
    return null;
  }

  // Detached HEAD holds the sha directly.
  const symbolic = head.match(/^ref:\s*(.+)$/);

  if (!symbolic) {
    return /^[0-9a-f]{40}$/i.test(head) ? head : null;
  }

  const ref = symbolic[1].trim();

  // A loose ref file, which is what exists right after a commit.
  try {
    const loose = fs.readFileSync(path.join(dir, ref), 'utf8').trim();

    if (loose) {
      return loose;
    }
  } catch (err) {
    // Not loose - it may be packed, which is the state after a clone or a
    // `git gc`.
  }

  try {
    const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
    const line = packed.split('\n')
      .find(l => l.endsWith(` ${ref}`) && !l.startsWith('#'));

    return line ? line.split(' ')[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * simple-git's `StatusSummary` sets `isClean` as an *own* property holding
 * a function. Electron's structured-clone algorithm refuses functions, so
 * handing the raw summary to a renderer fails with "An object could not be
 * cloned". Copy out just the plain data the UI needs.
 */
function toPlainStatus(status) {
  return {
    current: status.current,
    tracking: status.tracking,
    ahead: status.ahead,
    behind: status.behind,
    detached: status.detached,
    not_added: [...status.not_added],
    conflicted: [...status.conflicted],
    created: [...status.created],
    deleted: [...status.deleted],
    modified: [...status.modified],
    staged: [...status.staged],
    renamed: status.renamed.map(r => ({ from: r.from, to: r.to })),
    files: status.files.map(f => ({
      path: f.path,
      index: f.index,
      working_dir: f.working_dir
    })),
    isClean: status.isClean()
  };
}

async function getStatus() {
  const git = getGit();
  const status = await git.status();

  return { branch: status.current, status: toPlainStatus(status) };
}

async function getDiff(filePath) {
  const git = getGit();
  const args = filePath ? [filePath] : [];
  const staged = await git.diff(['--cached', ...args]);
  const unstaged = await git.diff(args);

  return { staged, unstaged };
}

async function commitAll(message) {
  const git = getGit();
  await git.add(['-A']);
  return git.commit(message);
}

/**
 * Reject anything that could escape the configured repository before it
 * reaches a git command. Paths always originate from our own status
 * listing, but this is the boundary between the HTTP bridge and the
 * filesystem, so it is validated here rather than assumed.
 */
function assertSafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || !relPath.length) {
    throw new Error('a file path is required');
  }

  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`expected a repository-relative path, got "${relPath}"`);
  }

  const normalized = path.normalize(relPath);

  if (normalized.startsWith('..')) {
    throw new Error(`path escapes the repository: "${relPath}"`);
  }

  return normalized.split(path.sep).join('/');
}

async function stageFile(relPath) {
  const git = getGit();
  return git.add([ assertSafeRelativePath(relPath) ]);
}

/**
 * Unstage without touching the working tree.
 *
 * `git reset HEAD -- <path>` fails on a repository with no commits yet
 * (there is no HEAD to reset against), so that case falls back to
 * `git rm --cached`, which has the same practical effect.
 */
async function unstageFile(relPath) {
  const git = getGit();
  const safe = assertSafeRelativePath(relPath);

  try {
    return await git.reset([ 'HEAD', '--', safe ]);
  } catch (err) {
    return git.rm([ '--cached', safe ]);
  }
}

async function stageAll() {
  const git = getGit();
  return git.add([ '-A' ]);
}

/**
 * Commit what is already staged - unlike commitAll(), which stages
 * everything first.
 */
async function commitStaged(message) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('a commit message is required');
  }

  const git = getGit();
  const status = await git.status();

  if (!status.staged.length) {
    throw new Error('nothing is staged - tick some files first');
  }

  return git.commit(message.trim());
}

async function push() {
  const git = getGit();
  return git.push();
}

// NOTE: sending a branch to the server lives in branch-service as
// `publishCurrentBranch()`, not here. It has to know which branches are the
// long-lived ones to tell an inherited upstream from a deliberate one, and
// a plain `push()` that trusts `status.tracking` is exactly the mistake
// that let a workstream get pushed onto the shared branch. There is
// deliberately no convenience wrapper for it at this level.

async function pull() {
  const git = getGit();
  return git.pull();
}

async function getRemoteUrl(remoteName) {
  const git = getGit();
  const remotes = await git.getRemotes(true);
  const remote = remotes.find(r => r.name === (remoteName || 'origin'));

  if (!remote) {
    return null;
  }

  return remote.refs.fetch || remote.refs.push;
}

/**
 * Resolve `filePath` to a path relative to the repo root, so it can be
 * used in `git show HEAD:<relPath>` style commands.
 */
async function toRepoRelativePath(filePath) {
  const repoPath = getRepoPath();
  const relative = path.relative(repoPath, filePath);

  if (relative.startsWith('..')) {
    throw new Error(
      `"${filePath}" is not inside the configured repository (${repoPath}).`
    );
  }

  return relative.split(path.sep).join('/');
}

/**
 * Return the file's content as it was at HEAD, or `null` if the file
 * is new (not yet tracked / no previous commit has it).
 */
async function showFileAtHead(filePath) {
  const git = getGit();
  const relPath = await toRepoRelativePath(filePath);

  try {
    return await git.show([`HEAD:${relPath}`]);
  } catch (err) {
    // File didn't exist at HEAD (new/untracked file) - treat as empty.
    return null;
  }
}

module.exports = {
  getRepoPath,
  getGit,
  gitDir,
  readHeadSha,
  getStatus,
  getDiff,
  commitAll,
  stageFile,
  unstageFile,
  stageAll,
  commitStaged,
  push,
  pull,
  getRemoteUrl,
  toRepoRelativePath,
  showFileAtHead
};
