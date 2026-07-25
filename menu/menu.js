'use strict';

const fs = require('fs');
const path = require('path');
const { dialog, shell } = require('electron');
const prompt = require('electron-prompt');
const BpmnModdle = require('bpmn-moddle');
const { diff: bpmnDiff } = require('bpmn-js-differ');

const configStore = require('./config-store');
const gitService = require('./git-service');
const remoteService = require('./remote-service');
const { openWindow } = require('./windows');
const bridgeServer = require('./bridge-server');
const conflictService = require('./conflict-service');
const diagramDiffService = require('./diagram-diff-service');
const mergeRequestService = require('./merge-request-service');
const autoPull = require('./auto-pull');

// This module is required once, in the main process, when Modeler loads the
// plugin - so it is the natural place to bring the client bridge up.
bridgeServer.start();

// The bridge cannot touch Electron itself (it stays testable outside it),
// so this module injects the two things that need it.
bridgeServer.setUrlOpener(url => shell.openExternal(url));

bridgeServer.setFolderPicker(async () => {
  const picked = await dialog.showOpenDialog({
    title: 'Select the folder your diagrams live in',
    properties: [ 'openDirectory' ]
  });

  return picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
});

// Honour a saved auto-pull setting from the previous session.
autoPull.restart();

/**
 * Open the two conflicting versions of a diagram side by side.
 */
bridgeServer.setComparisonHandler(async filePath => {
  const versions = await conflictService.getVersions(filePath);

  // Computed here rather than in the window: it needs bpmn-moddle, which is
  // a Node dependency, and the comparison window is a plain page with no
  // bundler behind it.
  //
  // Failure is not fatal - two viewers side by side are still worth having
  // when one of the versions will not parse, which is itself a useful thing
  // to learn about a diagram you are choosing between.
  let diff = null;

  try {
    diff = await diagramDiffService.compare(versions.ours, versions.theirs);
  } catch (err) {
    console.error('[camunda-git-plugin] could not compare versions:', err);
    diff = { comparable: false, reason: `Could not compare these versions: ${err.message}` };
  }

  // A three-way analysis when there is a common ancestor to compare against -
  // which is exactly the conflict case, where `getVersions` reads all three
  // index stages. Without a base (one side added the file, or a plain
  // two-way review) there is nothing to merge, and `compare` alone stands.
  //
  // Consumed by the window (`ui/compare.js` renderMerge) to show which
  // differences actually clash. The *acting* on it - folding both sides into
  // one diagram - is a separate route (`/conflict/combine`, driven from the
  // Source Control panel), because resolution stages a file and the compare
  // window is deliberately read-only.
  let merge = null;

  if (versions.base) {
    try {
      merge = await diagramDiffService.merge(versions.base, versions.ours, versions.theirs);
    } catch (err) {
      console.error('[camunda-git-plugin] could not three-way merge:', err);
      merge = { mergeable: false, reason: `Could not merge these versions: ${err.message}` };
    }
  }

  openWindow({
    kind: 'compare',
    title: `Compare - ${path.basename(filePath)}`,
    htmlFile: 'compare.html',
    width: 1400,
    height: 820,
    handlers: {
      getVersions: async () => ({
        path: filePath,
        name: path.basename(filePath),
        ours: versions.ours,
        theirs: versions.theirs,
        diff,
        merge
      })
    }
  });
});

/**
 * Open the visual review of a merge request: every changed file listed, and
 * each diagram rendered before and after with synced zoom.
 *
 * The window pulls its data lazily over the namespaced IPC - the overview
 * once, then each file as it is opened - so a request touching many diagrams
 * does not parse them all up front.
 */
bridgeServer.setReviewHandler(async ({ source, target }) => {
  // Computed once here so a failure to reach the repo surfaces as an error
  // on the click, not an empty window.
  const overview = await mergeRequestService.reviewChanges({ source, target });

  openWindow({
    kind: 'mr-review',
    title: `Review ${source} → ${target}`,
    htmlFile: 'mr-review.html',
    width: 1500,
    height: 900,
    handlers: {
      getReview: async () => overview,
      getFile: async filePath =>
        mergeRequestService.reviewFile({ source, target, path: filePath })
    }
  });
});

function notify(title, message) {
  dialog.showMessageBox({ type: 'info', title, message });
}

function notifyError(title, err) {
  console.error(`[camunda-git-plugin] ${title}:`, err);
  dialog.showMessageBox({ type: 'error', title, message: err.message || String(err) });
}

async function promptText(opts) {
  return prompt(Object.assign({
    height: 160,
    width: 480,
    resizable: false
  }, opts));
}

// ---------------------------------------------------------------------
// Repository settings
// ---------------------------------------------------------------------

async function configureRepository() {
  const config = configStore.readConfig();

  const picked = await dialog.showOpenDialog({
    title: 'Select the git repository your BPMN/DMN files live in',
    defaultPath: config.repoPath,
    properties: ['openDirectory']
  });

  if (picked.canceled || !picked.filePaths.length) {
    return;
  }

  const repoPath = picked.filePaths[0];

  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    const confirmed = await dialog.showMessageBox({
      type: 'warning',
      title: 'Not a git repository',
      message: `${repoPath} does not look like a git repository (no .git folder). Use it anyway?`,
      buttons: ['Cancel', 'Use anyway']
    });
    if (confirmed.response !== 1) {
      return;
    }
  }

  const githubToken = await promptText({
    title: 'GitHub personal access token (optional)',
    label: 'Used for listing issues / rate limits. Leave blank to use the API unauthenticated.',
    value: config.githubToken || '',
    inputAttrs: { type: 'password' }
  });

  const gitlabHost = await promptText({
    title: 'GitLab host',
    label: 'e.g. gitlab.com or your self-hosted GitLab domain',
    value: config.gitlabHost || 'gitlab.com'
  });

  const gitlabToken = await promptText({
    title: 'GitLab personal access token (optional)',
    label: 'Used for listing issues on private projects.',
    value: config.gitlabToken || '',
    inputAttrs: { type: 'password' }
  });

  // How a finished workstream rejoins the shared version. Per project,
  // because a two-person team and a regulated process need different rules.
  const policyAnswer = await dialog.showMessageBox({
    type: 'question',
    title: 'When someone finishes a workstream',
    message: 'How should finished work rejoin the shared version?',
    detail:
      'Review first: opens a merge request so someone checks the diagrams ' +
      'before they reach the shared version.\n\n' +
      'Merge directly: the finished work goes straight in. Faster, but ' +
      'nothing stops a broken diagram reaching everyone.',
    buttons: [ 'Review first (recommended)', 'Merge directly' ],
    defaultId: 0,
    cancelId: 0
  });

  configStore.update({
    repoPath,
    githubToken: githubToken || '',
    gitlabHost: gitlabHost || 'gitlab.com',
    gitlabToken: gitlabToken || '',
    mergePolicy: policyAnswer.response === 1 ? 'direct' : 'review'
  });

  notify('Git plugin', `Repository configured:\n${repoPath}`);
}

// ---------------------------------------------------------------------
// Local git actions
// ---------------------------------------------------------------------

function openStatusWindow() {
  openWindow({
    kind: 'status',
    title: 'Git Status & Diff',
    htmlFile: 'status.html',
    handlers: {
      get: async () => {
        const config = configStore.readConfig();
        const { branch, status } = await gitService.getStatus();
        const { staged, unstaged } = await gitService.getDiff();
        return { repoPath: config.repoPath, branch, status, staged, unstaged };
      },
      commit: async message => {
        await gitService.commitAll(message);
        return { ok: true };
      },
      push: async () => {
        await gitService.push();
        return { ok: true };
      },
      pull: async () => {
        await gitService.pull();
        return { ok: true };
      }
    }
  });
}

async function commitAllChanges() {
  try {
    const message = await promptText({
      title: 'Commit all changes',
      label: 'Commit message:'
    });

    if (!message) {
      return;
    }

    const result = await gitService.commitAll(message);
    notify('Git plugin', `Committed ${result.summary.changes} change(s).`);
  } catch (err) {
    notifyError('Commit failed', err);
  }
}

async function pushChanges() {
  try {
    await gitService.push();
    notify('Git plugin', 'Push complete.');
  } catch (err) {
    notifyError('Push failed', err);
  }
}

async function pullChanges() {
  try {
    const summary = await gitService.pull();
    notify('Git plugin', `Pull complete. ${summary.summary ? '' : ''}${summary.files ? summary.files.length : 0} file(s) updated.`);
  } catch (err) {
    notifyError('Pull failed', err);
  }
}

// ---------------------------------------------------------------------
// Diagram diff
// ---------------------------------------------------------------------

function safeElementInfo(el) {
  if (!el) return null;
  const bo = el.businessObject || el;
  return {
    id: bo.id || el.id,
    type: bo.$type || el.$type || 'Unknown',
    name: bo.name || ''
  };
}

/**
 * Convert the (moddle-object-heavy, circular-reference-laden) result of
 * `bpmn-js-differ` into a small plain object that's safe to send across
 * an Electron IPC boundary (structured clone) and easy to render in the
 * diagram-diff window.
 */
function simplifyDiff(result) {
  const added = Object.keys(result._added || {}).map(id => safeElementInfo(result._added[id]));
  const removed = Object.keys(result._removed || {}).map(id => safeElementInfo(result._removed[id]));
  const layoutChanged = Object.keys(result._layoutChanged || {}).map(id => ({ id }));

  const changed = Object.keys(result._changed || {}).map(id => {
    const entry = result._changed[id];
    const info = safeElementInfo(entry && entry.model) || { id, type: 'Unknown', name: '' };
    const attrs = entry && entry.attrs ? Object.keys(entry.attrs) : [];
    return Object.assign({}, info, { attrs });
  });

  return {
    added,
    removed,
    changed,
    layoutChanged,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      layoutChanged: layoutChanged.length
    }
  };
}

async function showDiagramDiff() {
  try {
    const picked = await dialog.showOpenDialog({
      title: 'Select a BPMN file to diff against the last commit',
      filters: [{ name: 'BPMN files', extensions: ['bpmn', 'xml'] }],
      properties: ['openFile']
    });

    if (picked.canceled || !picked.filePaths.length) {
      return;
    }

    const filePath = picked.filePaths[0];
    const currentXml = fs.readFileSync(filePath, 'utf8');
    const headXml = await gitService.showFileAtHead(filePath);

    if (headXml === null) {
      notify('Git plugin', 'This file has no previous commit to diff against (it looks new/untracked).');
      return;
    }

    const moddle = new BpmnModdle();
    const [{ rootElement: oldDef }, { rootElement: newDef }] = await Promise.all([
      moddle.fromXML(headXml),
      moddle.fromXML(currentXml)
    ]);

    const result = bpmnDiff(oldDef, newDef);
    const simplified = simplifyDiff(result);

    openWindow({
      kind: 'diagram-diff',
      title: `Diagram Diff - ${path.basename(filePath)}`,
      htmlFile: 'diagram-diff.html',
      width: 1100,
      height: 750,
      handlers: {
        // Only plain, structured-clone-safe data crosses the IPC boundary -
        // the raw bpmn-moddle model objects from bpmn-js-differ (which
        // contain circular $parent references) are simplified first.
        getData: async () => ({
          fileName: path.basename(filePath),
          currentXml,
          diff: simplified
        })
      }
    });
  } catch (err) {
    notifyError('Diagram diff failed', err);
  }
}

// ---------------------------------------------------------------------
// GitHub / GitLab
// ---------------------------------------------------------------------

async function getRemoteInfo(kind) {
  const url = await gitService.getRemoteUrl('origin');

  if (!url) {
    throw new Error('No "origin" remote configured on this repository.');
  }

  const info = remoteService.parseRemote(url);

  if (kind === 'github' && !info.isGitHub) {
    throw new Error(`origin (${url}) does not look like a GitHub remote.`);
  }
  if (kind === 'gitlab' && !info.isGitLab) {
    throw new Error(`origin (${url}) does not look like a GitLab remote.`);
  }

  return info;
}

async function openRepoOnHost(kind) {
  try {
    const info = await getRemoteInfo(kind);
    shell.openExternal(remoteService.buildRepoUrl(info));
  } catch (err) {
    notifyError(`Open on ${kind}`, err);
  }
}

async function createGitHubPullRequest() {
  try {
    const info = await getRemoteInfo('github');
    const { branch } = await gitService.getStatus();

    const base = await promptText({
      title: 'Create Pull Request',
      label: 'Base branch (the branch you want to merge into):',
      value: 'main'
    });
    if (!base) return;

    const compare = await promptText({
      title: 'Create Pull Request',
      label: 'Compare branch (your branch with the changes):',
      value: branch
    });
    if (!compare) return;

    shell.openExternal(remoteService.buildGitHubCompareUrl(info, base, compare));
  } catch (err) {
    notifyError('Create Pull Request', err);
  }
}

async function createGitLabMergeRequest() {
  try {
    const info = await getRemoteInfo('gitlab');
    const { branch } = await gitService.getStatus();

    const target = await promptText({
      title: 'Create Merge Request',
      label: 'Target branch:',
      value: 'main'
    });
    if (!target) return;

    const source = await promptText({
      title: 'Create Merge Request',
      label: 'Source branch (your branch with the changes):',
      value: branch
    });
    if (!source) return;

    shell.openExternal(remoteService.buildGitLabMrUrl(info, source, target));
  } catch (err) {
    notifyError('Create Merge Request', err);
  }
}

function listIssues(kind) {
  openWindow({
    kind: 'issues',
    title: kind === 'github' ? 'GitHub Issues' : 'GitLab Issues',
    htmlFile: 'issues.html',
    handlers: {
      get: async () => {
        const info = await getRemoteInfo(kind);
        const config = configStore.readConfig();

        const issues = kind === 'github'
          ? await remoteService.listGitHubIssues(info, config.githubToken)
          : await remoteService.listGitLabIssues(info, config.gitlabToken);

        return { kind, repoPath: config.repoPath, issues };
      }
    }
  });
}

// ---------------------------------------------------------------------
// Menu definition
// ---------------------------------------------------------------------

module.exports = function(electronApp, menuState) {
  return [
    {
      label: 'Git: Repository Settings...',
      enabled: () => true,
      action: () => configureRepository()
    },
    { type: 'separator' },
    {
      label: 'Git: Status && Diff',
      enabled: () => true,
      action: () => openStatusWindow()
    },
    {
      label: 'Git: Commit All Changes...',
      accelerator: 'CommandOrControl+Alt+C',
      enabled: () => true,
      action: () => commitAllChanges()
    },
    {
      label: 'Git: Push',
      enabled: () => true,
      action: () => pushChanges()
    },
    {
      label: 'Git: Pull',
      enabled: () => true,
      action: () => pullChanges()
    },
    { type: 'separator' },
    {
      label: 'Diagram: Show Visual Diff vs Last Commit...',
      enabled: () => true,
      action: () => showDiagramDiff()
    },
    { type: 'separator' },
    {
      label: 'GitHub: Open Repository',
      enabled: () => true,
      action: () => openRepoOnHost('github')
    },
    {
      label: 'GitHub: Create Pull Request...',
      enabled: () => true,
      action: () => createGitHubPullRequest()
    },
    {
      label: 'GitHub: List Open Issues',
      enabled: () => true,
      action: () => listIssues('github')
    },
    { type: 'separator' },
    {
      label: 'GitLab: Open Repository',
      enabled: () => true,
      action: () => openRepoOnHost('gitlab')
    },
    {
      label: 'GitLab: Create Merge Request...',
      enabled: () => true,
      action: () => createGitLabMergeRequest()
    },
    {
      label: 'GitLab: List Open Issues',
      enabled: () => true,
      action: () => listIssues('gitlab')
    }
  ];
};
