/**
 * Conflict handling, designed for people who do not read git.
 *
 * The deliberate limitation here: resolution is *file-level only*. A BPMN
 * file is XML describing a graph, so a line-level three-way merge of two
 * diagrams produces something that is neither diagram and frequently is
 * not even valid XML. Nobody hand-merges `<bpmn:sequenceFlow>` hunks - not
 * analysts, not developers. So the only choices offered are "keep mine",
 * "keep theirs", and "show me both so I can decide".
 *
 * Anything more granular is a job for reopening the diagram and redoing
 * the change on top of the version that won.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const simpleGit = require('simple-git');

const gitService = require('./git-service');
const commandLog = require('./command-log');
const configStore = require('./config-store');
const naming = require('./naming');

// Release branches are not one of naming.js's work types, so `humanize()`
// leaves the prefix on. Handled with three lines here rather than by
// requiring release-service, which requires branch-service, which requires
// this module - a cycle for a cosmetic label.
const RELEASE_PREFIX = 'release/';

/**
 * The branch name as it should be read out loud.
 *
 * Computed here rather than in the renderer for the same reason the branch
 * naming rules are: a second copy of "how do we display a branch" in the
 * panel is a copy that drifts. The raw names are sent alongside, because
 * anything that has to *act* on a branch needs the real one.
 */
/**
 * Make the two sides tell each other apart.
 *
 * Labelling by branch name is right almost always, and fails in exactly one
 * case: when both sides *are* the same branch name. That is not a corner
 * case - it is what combining two histories looks like, where your `main`
 * and the server's `main` were started independently. "Choose which version
 * to keep - Main or Main" is worse than useless.
 *
 * Falling back to ownership is unambiguous there, and only there: elsewhere
 * "mine/theirs" is the wording this module deliberately avoids, because
 * during a finish or a rebase it means the opposite of what a reader
 * assumes.
 */
function disambiguate(ours, theirs) {
  if (!ours || !theirs || ours !== theirs) {
    return { ours, theirs };
  }

  return { ours: `${ours} (yours)`, theirs: `${theirs} (the team's)` };
}

function titleOf(branchName) {
  const name = String(branchName || '');

  if (!name) {
    return null;
  }

  if (name.startsWith(RELEASE_PREFIX)) {
    return `Release ${name.slice(RELEASE_PREFIX.length)}`;
  }

  return naming.humanize(name, configStore.readConfig());
}

/**
 * A git instance allowed to set `core.editor`, used for nothing but
 * `--continue`.
 *
 * simple-git refuses editor configuration by default, and it is right to:
 * `core.editor` names a program to run, so anywhere it can be influenced by
 * input it is an execution vector. Here the value is a constant - `true`,
 * the command that does nothing and exits 0 - and it is needed because
 * `rebase --continue` opens an editor for the commit message. There is no
 * terminal behind this panel for git to open one in, so without this the
 * command hangs forever on an editor that never appears.
 *
 * Scoped to this one call rather than relaxed on the shared instance in
 * git-service, so the permission cannot be reached from anywhere else -
 * including the console, which refuses `-c` from users outright.
 */
function continuingGit() {
  return commandLog.instrument(simpleGit({
    baseDir: gitService.getRepoPath(),
    unsafe: { allowUnsafeEditor: true }
  }));
}

// Git's index stage numbers during a conflict.
const STAGE = {
  base: 1,    // common ancestor
  ours: 2,    // the version already in place
  theirs: 3   // the version being brought in
};

// Worktree-safe `.git` resolution lives in git-service; every state file
// below is read out of it.
const gitDir = gitService.gitDir;

function gitFile(...parts) {
  return path.join(gitDir(), ...parts);
}

/**
 * Which half-finished operation is in progress, if any.
 *
 * This is not just cosmetic. The plugin only ever *starts* merges, but it
 * now ships a console, so a developer can leave a rebase or a cherry-pick
 * half-done - and the recovery commands are different for each. Treating
 * them all as a merge means "Start over" runs `git merge --abort` and fails
 * with "there is no merge to abort", which strands someone at exactly the
 * moment the escape hatch is the whole point.
 */
function operationInProgress() {
  if (fs.existsSync(gitFile('rebase-merge')) || fs.existsSync(gitFile('rebase-apply'))) {
    return {
      type: 'rebase',

      // Plain language, because this is what the panel says out loud.
      label: 'replaying your changes on top of the latest version',
      startOver: 'Your changes go back to where they were before this started.'
    };
  }

  if (fs.existsSync(gitFile('CHERRY_PICK_HEAD'))) {
    return {
      type: 'cherry-pick',
      label: 'copying a single save point across',
      startOver: 'The copy is cancelled. Nothing else is touched.'
    };
  }

  if (fs.existsSync(gitFile('REVERT_HEAD'))) {
    return {
      type: 'revert',
      label: 'undoing an earlier save point',
      startOver: 'The undo is cancelled. Nothing else is touched.'
    };
  }

  if (fs.existsSync(gitFile('MERGE_HEAD'))) {
    return {
      type: 'merge',
      label: 'combining the team\'s changes with yours',
      startOver: 'The combine is cancelled. Your saved work is untouched.'
    };
  }

  return null;
}

/**
 * Is something half-finished that the user has to resolve?
 *
 * Checked from disk rather than by parsing status output, because this
 * needs to be reliable enough to gate the whole UI.
 */
function isMergeInProgress() {
  return !!operationInProgress();
}

/**
 * Which branch is on each side of the current merge.
 *
 * This matters more than it looks. "ours" is always whatever is checked
 * out, so the meaning flips depending on how the merge started:
 *
 *   getting team updates   -> ours = your workstream, theirs = the team's
 *   finishing a workstream -> ours = the shared version, theirs = YOUR work
 *
 * Labelling the buttons "Keep mine"/"Keep theirs" is therefore wrong half
 * the time - and wrong in the direction where someone discards their own
 * work believing they are keeping it. The UI labels by branch name
 * instead, which is unambiguous in both directions.
 */
async function nameOf(sha) {
  const git = gitService.getGit();

  try {
    const named = await git.raw([ 'name-rev', '--name-only', sha ]);

    return named.trim()
      .replace(/^remotes\//, '')
      .replace(/[~^].*$/, '');   // "main~2" -> "main"
  } catch (err) {
    return null;
  }
}

function readGitFile(...parts) {
  try {
    return fs.readFileSync(gitFile(...parts), 'utf8').trim();
  } catch (err) {
    return null;
  }
}

async function getMergeContext() {
  const operation = operationInProgress();

  if (!operation) {
    return { ours: null, theirs: null, operation: null };
  }

  const { status } = await gitService.getStatus();

  // A rebase *inverts* the sides. Your commits are replayed on top of the
  // other branch, so git's "ours" is the branch you are moving onto and
  // "theirs" is your own work - the exact opposite of a merge.
  //
  // This is the same hazard this module already guards against by labelling
  // buttons with branch names, and it is worse here: someone told "keep
  // ours" during a rebase discards their own changes while believing they
  // are keeping them. So the sides are resolved per operation rather than
  // assumed from HEAD.
  if (operation.type === 'rebase') {
    const headName = readGitFile('rebase-merge', 'head-name') ||
      readGitFile('rebase-apply', 'head-name');

    const ontoSha = readGitFile('rebase-merge', 'onto') ||
      readGitFile('rebase-apply', 'onto');

    const ours = (ontoSha && await nameOf(ontoSha)) || 'the latest version';
    const theirs = (headName || '').replace('refs/heads/', '') || status.current;

    return {
      ours,
      theirs,
      oursTitle: titleOf(ours) || ours,
      theirsTitle: titleOf(theirs) || theirs,
      operation,

      // The panel says this out loud, because "ours" reading as "the other
      // branch" is not something anyone should have to infer.
      inverted: true
    };
  }

  const ours = status.current;
  const marker = operation.type === 'cherry-pick' ? 'CHERRY_PICK_HEAD'
    : operation.type === 'revert' ? 'REVERT_HEAD'
      : 'MERGE_HEAD';

  const sha = readGitFile(marker);

  let theirs = sha ? await nameOf(sha) : null;

  // `git name-rev` answers with whatever ref reaches the commit most
  // directly, and that is often `origin/HEAD` - the remote's default-branch
  // pointer, which resolves to the same commit as `origin/main`. It is not a
  // branch name, and "Origin/HEAD" as a button label is precisely the
  // meaningless answer this module exists to avoid: the whole reason the
  // sides are named at all is that "keep mine" is ambiguous.
  //
  // The prepared merge message names the real branch ("Merge branch 'main'
  // of ..."), so it is preferred whenever name-rev lands on a HEAD pointer.
  if (!theirs || /(^|\/)HEAD$/.test(theirs)) {
    const msg = readGitFile('MERGE_MSG') || '';
    const match = msg.match(/Merge (?:branch|remote-tracking branch) '([^']+)'/);

    theirs = match ? match[1] : (theirs && !/(^|\/)HEAD$/.test(theirs) ? theirs : null);
  }

  const titles = disambiguate(titleOf(ours) || ours, titleOf(theirs) || theirs);

  return {
    ours,
    theirs,
    oursTitle: titles.ours,
    theirsTitle: titles.theirs,
    operation,
    inverted: false
  };
}

/**
 * The conflicted files, with enough context to describe each one in plain
 * language.
 *
 * `deletedBy` marks the nasty case where one side deleted the file and the
 * other edited it - "keep theirs" then means "accept the deletion", which
 * the UI needs to say out loud.
 */
async function listConflicts() {
  const { status } = await gitService.getStatus();

  return Promise.all((status.conflicted || []).map(async filePath => {
    const entry = status.files.find(f => f.path === filePath) || {};

    // DD/DU/UD in the porcelain columns mean a delete is involved.
    const ours = entry.index;
    const theirs = entry.working_dir;

    let deletedBy = null;
    if (ours === 'D' && theirs === 'U') {
      deletedBy = 'us';
    } else if (ours === 'U' && theirs === 'D') {
      deletedBy = 'them';
    } else if (ours === 'D' && theirs === 'D') {
      deletedBy = 'both';
    }

    return {
      path: filePath,
      name: path.basename(filePath),
      isDiagram: /\.(bpmn|dmn|form)$/i.test(filePath),
      deletedBy,
      hasOurs: deletedBy !== 'us' && deletedBy !== 'both',
      hasTheirs: deletedBy !== 'them' && deletedBy !== 'both'
    };
  }));
}

/**
 * Files that were conflicted and have since been decided.
 *
 * While an operation is open, everything staged is part of it, so this is
 * simply "staged but no longer conflicted". The panel needs it to show
 * progress ("4 of 7 decided") and to offer an undo per file, rather than
 * making the whole list vanish one row at a time with no way back.
 */
async function listResolved() {
  if (!isMergeInProgress()) {
    return [];
  }

  const { status } = await gitService.getStatus();
  const conflicted = new Set(status.conflicted || []);

  return status.files
    .filter(f => !conflicted.has(f.path) && f.index !== ' ' && f.index !== '?')
    .map(f => ({
      path: f.path,
      name: path.basename(f.path),
      isDiagram: /\.(bpmn|dmn|form)$/i.test(f.path),

      // 'D' in the index column means the decision was to drop the file.
      removed: f.index === 'D'
    }));
}

/**
 * Fetch one side of a conflicted file straight out of the index.
 *
 * Returns null when that side does not exist (a delete/modify conflict),
 * rather than throwing - the caller renders "this side deleted it".
 */
async function readVersion(filePath, side) {
  const git = gitService.getGit();
  const rel = await gitService.toRepoRelativePath(
    path.isAbsolute(filePath)
      ? filePath
      : path.join(gitService.getRepoPath(), filePath)
  );

  try {
    return await git.show([ `:${STAGE[side]}:${rel}` ]);
  } catch (err) {
    return null;
  }
}

async function getVersions(filePath) {
  const [ ours, theirs, base ] = await Promise.all([
    readVersion(filePath, 'ours'),
    readVersion(filePath, 'theirs'),
    readVersion(filePath, 'base')
  ]);

  return { path: filePath, ours, theirs, base };
}

/**
 * Resolve one file by taking a whole side.
 *
 * `git checkout --ours/--theirs` does not work when the conflict involves
 * a deletion (there is no blob to check out), so those cases are handled
 * with explicit add/rm instead.
 */
async function resolveFile(filePath, keep) {
  if (keep !== 'mine' && keep !== 'theirs') {
    throw new Error(`unknown resolution "${keep}"`);
  }

  const git = gitService.getGit();
  const conflicts = await listConflicts();
  const entry = conflicts.find(c => c.path === filePath);

  if (!entry) {
    throw new Error(`"${filePath}" is not currently conflicted.`);
  }

  const wantOurs = keep === 'mine';
  const sideExists = wantOurs ? entry.hasOurs : entry.hasTheirs;

  // The chosen side deleted the file: resolve by removing it.
  if (!sideExists) {
    await git.rm([ filePath ]);
    return { path: filePath, kept: keep, outcome: 'deleted' };
  }

  // The *other* side deleted it and we are keeping this one: the file is
  // already in the working tree, so staging it is the whole resolution.
  const otherExists = wantOurs ? entry.hasTheirs : entry.hasOurs;

  if (!otherExists) {
    await git.add([ filePath ]);
    return { path: filePath, kept: keep, outcome: 'kept' };
  }

  await git.raw([ 'checkout', wantOurs ? '--ours' : '--theirs', '--', filePath ]);
  await git.add([ filePath ]);

  return { path: filePath, kept: keep, outcome: 'kept' };
}

/**
 * Put a file back to being conflicted, undoing a decision.
 *
 * Without this the only way to change your mind is to abort the whole
 * operation and start again - which is a lot of ceremony for clicking the
 * wrong button on one file out of twelve, and enough of a cliff that people
 * click "Finish" on a resolution they know is wrong.
 *
 * `checkout --merge` rebuilds the conflict from the index stages, which are
 * still there until the operation completes. It is safe by construction:
 * the three versions it restores from are the ones git recorded when the
 * conflict appeared.
 */
async function undoResolution(filePath) {
  if (!isMergeInProgress()) {
    throw new Error('There is nothing in progress to undo.');
  }

  const git = gitService.getGit();
  const safe = await gitService.toRepoRelativePath(
    path.isAbsolute(filePath) ? filePath : path.join(gitService.getRepoPath(), filePath)
  );

  await git.raw([ 'checkout', '--merge', '--', safe ]);

  return { path: safe, restored: true };
}

/**
 * Git writes the file list into MERGE_MSG as `#` comment lines, which
 * `git commit` only strips when it runs the editor. Committing with `-m`
 * keeps them verbatim, so the merge commit ends up with
 * "# Conflicts:\n#\torder.bpmn" in its body.
 */
function stripComments(message) {
  return message
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Finish once nothing is conflicted any more.
 *
 * Which command that is depends on what is in progress - a rebase is
 * continued, not committed, and committing mid-rebase would bury the
 * remaining commits instead of replaying them.
 */
async function completeMerge() {
  const remaining = await listConflicts();

  if (remaining.length) {
    throw new Error(
      `${remaining.length} diagram(s) still need a decision before you can finish.`
    );
  }

  const operation = operationInProgress();

  if (!operation) {
    throw new Error('There is nothing in progress to finish.');
  }

  const git = gitService.getGit();

  if (operation.type === 'merge') {
    const prepared = readGitFile('MERGE_MSG');

    return git.commit(stripComments(prepared || '') || 'Merge team updates');
  }

  // rebase / cherry-pick / revert all continue rather than commit.
  return continuingGit().raw([
    '-c', 'core.editor=true', operation.type, '--continue'
  ]);
}

/**
 * The escape hatch: undo the whole thing and go back to how it was.
 *
 * Safe for every operation it covers - each one discards only the
 * in-progress state, never committed work - which is exactly why a
 * non-technical user needs it available and unconditional.
 */
async function abortMerge() {
  const operation = operationInProgress();

  if (!operation) {
    throw new Error('There is nothing in progress to cancel.');
  }

  const git = gitService.getGit();

  return git.raw([ operation.type, '--abort' ]);
}

module.exports = {
  isMergeInProgress,
  operationInProgress,
  gitDir,
  getMergeContext,
  listConflicts,
  listResolved,
  getVersions,
  resolveFile,
  undoResolution,
  stripComments,
  completeMerge,
  abortMerge
};
