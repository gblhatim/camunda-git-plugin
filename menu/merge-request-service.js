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

module.exports = {
  list,
  startResolution
};
