/**
 * Merge requests, resolved *in Modeler*.
 *
 * A pull/merge request that the host reports as conflicting cannot be
 * merged from its web page, and that web page is useless for a `.bpmn`
 * anyway - it shows raw XML with conflict markers, which is neither a
 * diagram nor valid. The whole reason this plugin renders diagrams is to
 * make that decision visible.
 *
 * So this does two things. `list()` fetches the open requests from GitHub
 * or GitLab and flags which ones conflict. `startResolution()` reproduces
 * the conflict *locally* - it lands on the request's source branch and
 * merges the target in - which drops the working tree into exactly the
 * state `conflict-service` and the panel's resolver already handle. The
 * user resolves each diagram visually, finishes, and pushes; the host then
 * recomputes the request as mergeable on its own. No API write is ever
 * needed to resolve.
 */

'use strict';

const gitService = require('./git-service');
const configStore = require('./config-store');
const remoteService = require('./remote-service');
const branchService = require('./branch-service');
const conflictService = require('./conflict-service');
const diagramDiffService = require('./diagram-diff-service');

/**
 * The parsed origin, or a clear reason there are no merge requests to show.
 */
async function resolveHost() {
  const url = await gitService.getRemoteUrl('origin');

  if (!url) {
    throw new Error(
      'This project has no team server yet, so it has no merge requests.'
    );
  }

  return { url, info: remoteService.parseRemote(url) };
}

/**
 * The open merge/pull requests, each flagged with whether it conflicts and
 * whether its source branch is the one you are on.
 */
async function list() {
  const { info } = await resolveHost();

  if (!info.isGitHub && !info.isGitLab) {
    return {
      supported: false,
      provider: null,
      host: info.host,
      items: []
    };
  }

  const config = configStore.readConfig();
  const provider = info.isGitHub ? 'GitHub' : 'GitLab';

  let items;

  try {
    items = info.isGitHub
      ? await remoteService.listGitHubPulls(info, config.githubToken)
      : await remoteService.listGitLabMergeRequests(info, config.gitlabToken);
  } catch (err) {
    // A failed API call - most often a private project with no token - is
    // reported *inside* a supported result rather than thrown, so the tab
    // still appears and can say what to do about it instead of vanishing.
    return {
      supported: true,
      provider,
      host: info.host,
      items: [],
      error: err.message
    };
  }

  const { status } = await gitService.getStatus();
  const current = status.current;

  items.forEach(mr => { mr.isCurrent = !!current && mr.source === current; });

  // Conflicting ones first, then the branch you are on, so the list opens
  // on what actually needs doing.
  items.sort((a, b) =>
    (b.hasConflicts === true) - (a.hasConflicts === true) ||
    (b.isCurrent - a.isCurrent) ||
    a.number - b.number
  );

  return {
    supported: true,
    provider: info.isGitHub ? 'GitHub' : 'GitLab',
    host: info.host,
    currentBranch: current,
    items
  };
}

/**
 * Reproduce a merge request's conflicts locally so they can be resolved in
 * the panel: fetch, land on the source branch, merge the target in.
 *
 * Leaves the working tree mid-merge when it conflicts - which is not a
 * failure but the whole point, and exactly the state `isMergeInProgress`
 * gates the resolver on. Returns `hasConflicts` (never `conflicts`, which
 * the bridge fills with the actual list the panel renders).
 */
async function startResolution({ source, target }) {
  if (!source || !target) {
    throw new Error('A merge request needs both a source and a target branch.');
  }

  if (source === target) {
    throw new Error('This request merges a branch into itself; there is nothing to resolve.');
  }

  if (conflictService.isMergeInProgress()) {
    throw new Error(
      'Finish or cancel the merge already in progress before starting another.'
    );
  }

  await resolveHost();

  const git = gitService.getGit();

  // Everything below needs the server's current idea of both branches.
  await git.fetch([ 'origin' ]);

  if (!(await branchService.remoteBranchExists(target))) {
    throw new Error(`The target branch "${target}" is not on the server.`);
  }

  // Land on the request's source branch. `switchTo` saves any work in
  // progress before checking out, and creates the local branch from
  // origin if it only existed on the server.
  const { status } = await gitService.getStatus();
  let switched = null;

  if (status.current !== source) {
    switched = await branchService.switchTo(source);
  } else {
    // Already here: still commit any work in progress so a dirty tree
    // cannot block the merge.
    await branchService.saveWorkInProgress();
  }

  let mergeError = null;

  try {
    await git.merge([ `origin/${target}` ]);
  } catch (err) {
    mergeError = err;
  }

  const conflicts = await conflictService.listConflicts();
  const merging = conflictService.isMergeInProgress();

  // A merge that ended without leaving a conflict state, yet threw, is a
  // real error (a missing ref, a refusal) rather than the expected
  // "resolve me" outcome.
  if (mergeError && !merging && !conflicts.length) {
    throw mergeError;
  }

  return {
    started: true,
    source,
    target,
    switched,
    merging,
    hasConflicts: merging && conflicts.length > 0,
    conflictCount: conflicts.length,

    // Clean merges happen too: the branch simply was not as far behind as
    // the host thought, or a fetch since made it mergeable.
    upToDate: !merging && !conflicts.length
  };
}

// =====================================================================
// Reviewing a merge request: what it changes, before and after.
//
// A read-only view - it never checks anything out or merges. It resolves
// the two branches (preferring the server's copy, since a merge request is
// defined by what was pushed), finds their merge base, and diffs the base
// against the source. That is the three-dot diff a host's "Files changed"
// tab shows: exactly what the request adds, without the target's own later
// work bleeding in.
// =====================================================================

const DIAGRAM_EXT = /\.(bpmn|dmn|form)$/i;

/**
 * Prefer the server's copy of a branch - the request is defined by what was
 * pushed - falling back to a local branch of the same name when there is no
 * remote-tracking ref (offline, or never fetched).
 */
async function resolveRef(name) {
  return (await branchService.remoteBranchExists(name)) ? `origin/${name}` : name;
}

async function refsFor(source, target) {
  const [ sourceRef, targetRef ] = await Promise.all([
    resolveRef(source), resolveRef(target)
  ]);

  const git = gitService.getGit();
  const base = (await git.raw([ 'merge-base', targetRef, sourceRef ])).trim();

  return { sourceRef, targetRef, base };
}

/**
 * The changed files of a merge request, diagrams first. `-M` reports a moved
 * diagram as a rename rather than a delete plus an add.
 */
async function listChanged({ base, sourceRef }) {
  const git = gitService.getGit();
  const out = await git.raw([ 'diff', '--name-status', '-M', base, sourceRef ]);

  const files = out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const cols = line.split('\t');
      const letter = (cols[0] || '').charAt(0).toUpperCase();
      const renameLike = letter === 'R' || letter === 'C';
      const filePath = renameLike ? (cols[2] || cols[1] || '') : (cols[1] || '');

      return {
        status: letter,
        path: filePath,
        from: renameLike ? (cols[1] || null) : null,
        name: filePath.split('/').pop(),
        isDiagram: DIAGRAM_EXT.test(filePath)
      };
    });

  // Diagrams first - they are the ones with a visual review - then the rest
  // alphabetically.
  files.sort((a, b) =>
    (b.isDiagram - a.isDiagram) || a.path.localeCompare(b.path)
  );

  return files;
}

async function reviewChanges({ source, target }) {
  if (!source || !target) {
    throw new Error('A review needs both a source and a target branch.');
  }

  await resolveHost();

  const git = gitService.getGit();

  // Get the server's current idea of both branches so the review matches the
  // merge request. Offline is not fatal - fall back to whatever is local.
  try {
    await git.fetch([ 'origin' ]);
  } catch (err) {
    // keep going with local refs
  }

  const refs = await refsFor(source, target);
  const files = await listChanged(refs);

  return {
    source,
    target,
    base: refs.base,
    fileCount: files.length,
    diagramCount: files.filter(f => f.isDiagram).length,
    files
  };
}

/**
 * The before and after of one file in the request, plus - for a diagram -
 * the element-level diff between them so the viewer can highlight what moved
 * and what changed.
 *
 * Recomputes the refs without a fetch (the list was just fetched when the
 * window opened) and validates the path against the actual change set, so a
 * client cannot ask git to show an arbitrary path.
 */
async function reviewFile({ source, target, path: rel }) {
  if (!source || !target || !rel) {
    throw new Error('A file review needs a source, a target, and a path.');
  }

  gitService.assertSafeRelativePath(rel);

  const refs = await refsFor(source, target);
  const files = await listChanged(refs);
  const entry = files.find(f => f.path === rel);

  if (!entry) {
    throw new Error('That file is not part of this merge request.');
  }

  const git = gitService.getGit();

  const show = async (ref, at) => {
    try {
      return await git.show([ `${ref}:${at}` ]);
    } catch (err) {
      return null;
    }
  };

  const beforePath = entry.from || rel;

  const before = entry.status === 'A' ? null : await show(refs.base, beforePath);
  const after = entry.status === 'D' ? null : await show(refs.sourceRef, rel);

  // The element-level diff is only meaningful for a diagram present on both
  // sides; an add or a delete has only one version to show.
  let diff = null;

  if (entry.isDiagram && before && after) {
    try {
      diff = await diagramDiffService.compare(before, after);
    } catch (err) {
      diff = { comparable: false, reason: `Could not compare these versions: ${err.message}` };
    }
  }

  return {
    path: rel,
    name: entry.name,
    status: entry.status,
    from: entry.from,
    isDiagram: entry.isDiagram,
    before,
    after,
    diff
  };
}

module.exports = {
  list,
  startResolution,
  reviewChanges,
  reviewFile
};
