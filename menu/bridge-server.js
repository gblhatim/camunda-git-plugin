/**
 * Localhost bridge between the plugin's main-process code and its
 * client-side (renderer) React components.
 *
 * Why this exists: Camunda Modeler's preload script enforces a hardcoded
 * allowlist of IPC channels and throws `Disallowed event` for anything
 * else, so a `script` plugin cannot open its own ipcRenderer channel to
 * reach Node APIs. It can, however, make ordinary HTTP requests - the
 * app's CSP is `script-src 'self'` with no `default-src`, so `connect-src`
 * is unrestricted.
 *
 * So: the main process (full Node access, can run git) serves a tiny
 * read-only HTTP API on the loopback interface, and the React panel
 * fetches from it.
 *
 * Security posture:
 *  - binds 127.0.0.1 only, never 0.0.0.0
 *  - every request must carry the shared token generated at startup
 *  - responses are JSON only; no shell input is taken from the request
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const gitService = require('./git-service');
const routines = require('./routines');
const conflictService = require('./conflict-service');
const gitErrors = require('./git-errors');
const branchService = require('./branch-service');
const fileService = require('./file-service');
const commandLog = require('./command-log');
const gitConsole = require('./git-console');
const projectSetup = require('./project-setup');
const contextService = require('./context-service');
const setupService = require('./setup-service');
const settingsService = require('./settings-service');
const autoPull = require('./auto-pull');
const historyService = require('./history-service');
const nextAction = require('./next-action');
const releaseService = require('./release-service');
const mergeRequestService = require('./merge-request-service');
const searchService = require('./search-service');
const aiService = require('./ai-service');
const catalogService = require('./catalog-service');
const supportService = require('./support-service');

// Set by menu.js, which owns the Electron windows. Kept as an injected
// callback so this module stays testable outside Electron.
let showComparison = null;

function setComparisonHandler(fn) {
  showComparison = fn;
}

// Set by menu.js: opens the merge-request review window (all changed files,
// before/after, synced viewers). Injected for the same reason as above.
let showReview = null;

function setReviewHandler(fn) {
  showReview = fn;
}

// Set by menu.js: opens the before/after window for a held AI proposal,
// reusing the same review window the merge requests use.
let showAiReview = null;

function setAiReviewHandler(fn) {
  showAiReview = fn;
}

// Set by menu.js: opens a read-only viewer for one catalog pattern.
let showCatalogPreview = null;

function setCatalogPreviewHandler(fn) {
  showCatalogPreview = fn;
}

// Opens a URL in the user's browser; injected for the same reason.
let openExternal = null;

function setUrlOpener(fn) {
  openExternal = fn;
}

// Opens a native folder-chooser; injected for the same reason.
let pickFolder = null;

function setFolderPicker(fn) {
  pickFolder = fn;
}

// Opens a file with its OS default app (the .eml draft in the mail client);
// injected so this module stays free of Electron.
let openFile = null;

function setFileOpener(fn) {
  openFile = fn;
}

// Fixed port by default; the client learns it from bridge.js either way,
// so overriding is safe and makes the server testable outside Modeler.
const PORT = Number(process.env.CAMUNDA_GIT_BRIDGE_PORT) || 45678;
const HOST = '127.0.0.1';

const TOKEN = crypto.randomBytes(16).toString('hex');

let server = null;

/**
 * A stamp that changes whenever anything the heavier tabs display has
 * changed: which branch you are on, what the branch points at, which files
 * differ, and whether a merge is open.
 *
 * This is what makes the panel keep itself up to date without polling five
 * routes every five seconds. `/status` is cheap and already polled; the
 * file tree, history, workstream list and command log are not, so they
 * reload when this value moves rather than on a timer of their own.
 *
 * It is deliberately derived from git's own answers rather than from
 * filesystem watching: a diagram saved by Modeler, a commit made in a
 * terminal, and a branch created by the console all move it the same way.
 */
/**
 * Field separator for the stamp below.
 *
 * Written as an escape rather than the literal character it used to be. A
 * raw NUL byte in the source makes every text tool classify this file as
 * binary - `grep` reports "Binary file ... matches" and prints nothing,
 * which silently hides this module from any search of the route table.
 *
 * The unit separator does the same job (the stamp is only ever compared for
 * equality, and this cannot occur in a branch name or a path) while leaving
 * the file greppable.
 */
const FIELD_SEP = '\x1f';

function revisionOf(status, head, merging) {
  return [
    status.current || '-',
    head || '-',
    status.tracking || '-',
    status.ahead,
    status.behind,

    // Path *and* state, so staging a file counts as a change even though
    // the file count did not move.
    status.files.map(f => `${f.index}${f.working_dir}${f.path}`).join('|'),
    merging ? 'merging' : ''
  ].join(FIELD_SEP);
}

/**
 * Branch, ahead/behind, and a per-status-code file count - everything the
 * status bar needs, cheap enough to poll.
 */
async function readStatus() {
  const { branch, status } = await gitService.getStatus();
  const merging = conflictService.isMergeInProgress();

  // Read from the refs rather than shelled out: `git rev-parse HEAD` fails
  // on a repository with no commits, and this runs on every poll.
  const head = gitService.readHeadSha();

  return {
    // "HEAD" is what simple-git reports when nothing is checked out; it is
    // not a branch name and the panel must not present it as one.
    branch: status.detached ? null : branch,
    detached: !!status.detached,
    head,
    revision: revisionOf(status, head, merging),
    ahead: status.ahead,
    behind: status.behind,
    tracking: status.tracking,
    isClean: status.isClean,
    counts: {
      modified: status.modified.length,
      created: status.created.length,
      deleted: status.deleted.length,
      untracked: status.not_added.length,
      conflicted: status.conflicted.length
    },
    changedTotal: status.files.length,

    // Drives the whole panel: when a merge is half-finished, resolving it
    // is the only thing the user should be doing.
    merging,
    conflictCount: status.conflicted.length,

    // Per-file detail for the Source Control panel. `index` is the staged
    // column and `working_dir` the unstaged one, straight from
    // `git status --porcelain`.
    files: status.files.map(f => ({
      path: f.path,
      index: f.index,
      working_dir: f.working_dir,
      staged: f.index !== ' ' && f.index !== '?'
    }))
  };
}

// Read-only; safe to poll.
const getRoutes = {
  '/ping': async () => ({ ok: true, plugin: 'camunda-git-plugin' }),
  '/status': readStatus,
  '/conflicts': async () => ({
    merging: conflictService.isMergeInProgress(),
    context: await conflictService.getMergeContext(),
    conflicts: await conflictService.listConflicts(),
    resolved: await conflictService.listResolved()
  }),
  '/workstreams': async () => branchService.listWorkstreams(),
  '/tree': async () => fileService.getTree({ diagramsOnly: true }),
  '/tree/all': async () => fileService.getTree({ diagramsOnly: false }),
  '/activity': async () => ({
    entries: commandLog.list({ limit: 150 }),
    consoleEnabled: gitConsole.isEnabled()
  }),
  '/history': async () => historyService.getHistory({ limit: 120 }),
  '/save-points': async () => historyService.listSavePoints({ limit: 60 }),

  // Advisory only - what the "My work" tab should lead with. Nothing is
  // gated on it; every routine still checks its own preconditions.
  '/next-action': async () => nextAction.get(),

  // --- the integrator's view -------------------------------------------
  '/release': async () => releaseService.inspect(),
  '/release/changes': async () => releaseService.unreleasedChanges({ limit: 100 }),
  '/settings': async () => ({
    settings: settingsService.read(),
    autoPull: autoPull.state(),
    blockedReason: await autoPull.checkPreconditions()
  }),
  '/project/setup': async () => projectSetup.inspect(),
  '/context': async () => contextService.get(),

  // Open pull/merge requests from the team server, flagged with which ones
  // conflict. Read-only; the resolving happens on a POST below.
  '/merge-requests': async () => mergeRequestService.list(),

  // Deliberately does not need a working repository - it is what answers
  // "there isn't one yet".
  '/setup': async () => setupService.inspect(),

  // The shipped BPMN patterns. Read from the plugin folder, so it needs no
  // repository - the catalog is browsable before setup.
  '/catalog': async () => catalogService.list()
};

/**
 * Mutating routes. These are POST-only so that a stray <img src> or a
 * navigation can never trigger one, and each returns the refreshed status
 * so the panel updates from a single round trip.
 */
const postRoutes = {
  '/stage': async body => {
    await gitService.stageFile(body.path);
    return readStatus();
  },
  '/unstage': async body => {
    await gitService.unstageFile(body.path);
    return readStatus();
  },
  '/stage-all': async () => {
    await gitService.stageAll();
    return readStatus();
  },
  '/commit': async body => {
    const result = await gitService.commitStaged(body.message);
    const status = await readStatus();
    return Object.assign({ committed: result.commit || null }, status);
  },
  // Goes through branch-service rather than a plain `git push`, so the
  // destination is always an explicit refspec for the branch you are on.
  '/push': async () => {
    await branchService.publishCurrentBranch();
    return readStatus();
  },
  // Like /push, this goes through branch-service so a branch with no
  // upstream - or the wrong one - is handled rather than reported as a
  // failure the reader cannot act on.
  '/pull': async () => {
    const result = await branchService.pullCurrentBranch();
    const status = await readStatus();

    return result.summary ? Object.assign({ summary: result.summary }, status) : status;
  },

  // Routines. The preview is a separate route from the run so that showing
  // the user what will happen can never accidentally do it.
  '/routine/save/preview': async () => routines.planSaveMyWork(),

  '/routine/save/run': async body => {
    const result = await routines.runSaveMyWork(body.message);
    return Object.assign(result, { status: await readStatus() });
  },

  // --- conflicts -------------------------------------------------------

  '/conflict/resolve': async body => {
    const decision = await conflictService.resolveFile(body.path, body.keep);
    const conflicts = await conflictService.listConflicts();

    return {
      context: await conflictService.getMergeContext(),
      decision,
      remaining: conflicts.length,
      conflicts,
      resolved: await conflictService.listResolved(),
      status: await readStatus()
    };
  },

  // Combine both sides of a conflicted diagram into one, rather than
  // keeping a side. Returns the same refreshed shape as resolve, so the
  // panel updates in one round trip.
  '/conflict/combine': async body => {
    const combined = await conflictService.combineFile(body.path);
    const conflicts = await conflictService.listConflicts();

    return {
      context: await conflictService.getMergeContext(),
      combined,
      summary: 'Combined both versions and saved the result.',
      remaining: conflicts.length,
      conflicts,
      resolved: await conflictService.listResolved(),
      status: await readStatus()
    };
  },

  // Put one file back to being conflicted. The escape hatch for a decision
  // rather than for the whole operation.
  '/conflict/undo': async body => {
    const undone = await conflictService.undoResolution(body.path);
    const conflicts = await conflictService.listConflicts();

    return {
      context: await conflictService.getMergeContext(),
      undone,
      remaining: conflicts.length,
      conflicts,
      resolved: await conflictService.listResolved(),
      status: await readStatus()
    };
  },

  '/conflict/compare': async body => {
    if (!showComparison) {
      throw new Error('The comparison window is not available.');
    }

    await showComparison(body.path);
    return { ok: true };
  },

  '/merge/complete': async () => {
    await conflictService.completeMerge();
    return { ok: true, status: await readStatus() };
  },

  '/merge/abort': async () => {
    await conflictService.abortMerge();
    return { ok: true, status: await readStatus() };
  },

  // Read-only, but a POST because it takes a commit id - GET handlers here
  // do not receive the query string. Loaded lazily when a row is opened, so
  // the graph itself stays a single cheap `git log`.
  '/history/commit': async body => historyService.getCommit(body.hash),

  // Reproduce a merge request's conflicts locally so they can be resolved
  // in the panel. Returns the refreshed conflict shape so the panel can
  // switch straight into the resolver, exactly like /pull does when it
  // conflicts.
  // --- AI edits (OpenRouter) ------------------------------------------
  //
  // Preview asks the model and holds the proposal without writing anything;
  // apply writes the approved proposal and stages it; review opens the
  // before/after window. Nothing here ever commits.
  '/ai/edit/preview': async body =>
    aiService.editPreview({ path: body.path, instruction: body.instruction }),

  // Generate an edit from a finished chat, then preview it (same parse /
  // openable / diff gate as a one-line edit). Streaming is only for the chat
  // questions; the generated diagram must be complete before it can be shown.
  '/ai/edit/from-chat': async body =>
    aiService.editFromChat({ path: body.path, messages: body.messages }),

  '/ai/edit/apply': async body => {
    const result = await aiService.editApply({ path: body.path });

    return Object.assign(result, {
      status: await readStatus(),
      tree: await fileService.getTree({ diagramsOnly: true })
    });
  },

  '/ai/edit/discard': async body => aiService.discard(body.path),

  // The models this key can use, so the UI offers real ids instead of a
  // guessed default that 404s.
  '/ai/models': async () => aiService.listModels(),

  // Compile a support bundle and open it as a mail draft. Never sends -
  // drafts and opens for the user to review and send.
  '/support/report': async () => {
    const report = await supportService.buildReport();

    let openError = null;
    if (openFile) {
      // shell.openPath resolves to '' on success or an error string.
      openError = (await openFile(report.emlPath)) || null;
    }

    return Object.assign(report, {
      opened: !openError,
      openError
    });
  },

  // Open a read-only viewer window for one catalog pattern.
  '/catalog/preview': async body => {
    if (!showCatalogPreview) {
      throw new Error('The preview window is not available.');
    }

    await showCatalogPreview(body.id);
    return { ok: true };
  },

  // Start a new diagram from a catalog pattern: writes a unique .bpmn into
  // the repo and hands back its path and the refreshed tree so the panel can
  // open it.
  '/catalog/new': async body => {
    const created = await catalogService.createDiagram({ id: body.id, name: body.name });

    return Object.assign(created, {
      status: await readStatus(),
      tree: await fileService.getTree({ diagramsOnly: true })
    });
  },

  '/ai/edit/review': async body => {
    if (!showAiReview) {
      throw new Error('The review window is not available.');
    }

    await showAiReview({ path: body.path });
    return { ok: true };
  },

  // Semantic search across every diagram. Read-only, but a POST because it
  // takes a free-text query (GET handlers here do not receive the query
  // string) and can walk the whole corpus.
  '/search': async body => searchService.search(body.query || '', {
    limit: Number(body.limit) || 300
  }),

  // Open a host link (a merge request page) in the real browser. Restricted
  // to http(s) so the panel cannot be talked into opening a file: or other
  // scheme.
  '/open-url': async body => {
    const url = String(body.url || '');

    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Only http(s) links can be opened.');
    }

    if (openExternal) {
      openExternal(url);
    }

    return { ok: true };
  },

  // Open the visual review of a merge request (all changed files,
  // before/after, synced zoom). The heavy lifting happens in the window;
  // this just launches it.
  '/merge-request/review': async body => {
    if (!showReview) {
      throw new Error('The review window is not available.');
    }

    await showReview({ source: body.source, target: body.target });
    return { ok: true };
  },

  '/merge-request/resolve': async body => {
    const result = await mergeRequestService.startResolution({
      source: body.source,
      target: body.target
    });

    return Object.assign(result, {
      conflicts: await conflictService.listConflicts(),
      context: await conflictService.getMergeContext(),
      resolved: await conflictService.listResolved(),
      status: await readStatus()
    });
  },

  // --- workstreams -----------------------------------------------------

  '/workstream/switch': async body => {
    const result = await branchService.switchTo(body.name);

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  '/workstream/create': async body => {
    const result = await branchService.createWorkstream({
      type: body.type,
      ticket: body.ticket,
      title: body.title
    });

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  // --- releases and hotfixes -------------------------------------------
  //
  // These are the integrator's operations: each touches both long-lived
  // branches, so each returns the refreshed picture rather than a bare ok.

  '/release/start': async body => {
    const result = await releaseService.startRelease(body.version);

    return Object.assign(result, {
      release: await releaseService.inspect(),
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  '/release/integrate/preview': async body =>
    releaseService.planIntegrate({ branch: body.branch, version: body.version }),

  '/release/integrate': async body => {
    const result = await releaseService.integrate({
      branch: body.branch,
      version: body.version,
      deleteWhenDone: body.deleteWhenDone !== false,
      send: body.send !== false
    });

    return Object.assign(result, {
      release: await releaseService.inspect(),
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  '/release/back-merge': async () => {
    const result = await releaseService.backMerge();

    return Object.assign(result, {
      release: await releaseService.inspect(),
      status: await readStatus()
    });
  },

  '/routine/sync/preview': async () => routines.planSync(),

  '/routine/sync/run': async () => {
    const result = await routines.runSync();

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  // Going back to an earlier save point. Preview and run are separate for
  // the usual reason, and it matters more here than anywhere else: the
  // preview is the only place the user learns which files this touches.
  '/routine/rollback/preview': async body => routines.planRollback(body.sha),

  '/routine/rollback/run': async body => {
    const result = await routines.runRollback(body.sha);

    return Object.assign(result, {
      savePoints: (await historyService.listSavePoints({ limit: 60 })).savePoints,
      status: await readStatus()
    });
  },

  '/routine/finish/preview': async () => routines.planFinish(),

  '/routine/finish/run': async () => {
    const result = await routines.runFinish();

    // The review path hands back a URL rather than opening it itself, so
    // that routines.js stays free of Electron.
    if (result.openUrl && openExternal) {
      openExternal(result.openUrl);
    }

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  // Preview first, like every other operation that changes something: this
  // is the only place the reader learns whether the work is safely on the
  // shared branch or exists nowhere else.
  '/workstream/delete/preview': async body =>
    branchService.planDeleteWorkstream(body.name),

  '/workstream/delete': async body => {
    const result = await branchService.deleteWorkstream(body.name, {
      alsoOnServer: !!body.alsoOnServer,
      force: !!body.force
    });

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  // --- setup -----------------------------------------------------------
  //
  // Each of these completes exactly one checklist step and returns the
  // refreshed checklist, so the panel always renders from the real state
  // rather than assuming the step it just ran is now done.

  // Chooses a folder without adopting it as the project - cloning needs a
  // parent directory to put the copy in, which is not the project itself.
  '/setup/pick-folder': async () => {
    if (!pickFolder) {
      throw new Error('The folder picker is not available.');
    }

    const chosen = await pickFolder();

    return chosen ? { path: chosen } : { cancelled: true };
  },

  '/setup/init': async () => withSetup(setupService.initRepository()),
  '/setup/identity': async body => withSetup(setupService.setIdentity(body)),
  '/setup/first-save': async body =>
    withSetup(setupService.createFirstSavePoint(body.message)),
  '/setup/connect': async body => withSetup(setupService.connectRemote(body.url)),
  '/setup/clone': async body => withSetup(setupService.cloneProject(body)),
  '/setup/branch': async body => withSetup(setupService.createBranch(body.name)),

  // Team settings. Preview and apply are separate routes for the same
  // reason routines are: showing what would be written must never write it.
  '/project/setup/preview': async body => projectSetup.plan(body),

  '/project/setup/apply': async body => {
    const result = await projectSetup.apply(body);

    return Object.assign(result, {
      workstreams: await branchService.listWorkstreams(),
      status: await readStatus()
    });
  },

  '/settings': async body => {
    const settings = settingsService.update(body);

    // Interval or on/off may have changed - rebuild the timer.
    autoPull.restart();

    return { settings, autoPull: autoPull.state() };
  },

  '/settings/pick-folder': async () => {
    if (!pickFolder) {
      throw new Error('The folder picker is not available.');
    }

    const chosen = await pickFolder();

    if (!chosen) {
      return { cancelled: true, settings: settingsService.read() };
    }

    const settings = settingsService.update({ repoPath: chosen });
    autoPull.restart();

    return { settings };
  },

  '/auto-pull/now': async () => {
    const result = await autoPull.tick();
    return { result, status: await readStatus() };
  },

  '/activity/clear': async () => {
    commandLog.clear();
    return { entries: [] };
  },

  /**
   * Run a git command the user typed.
   *
   * POST-only like every other mutating route, and gated on developer mode
   * inside git-console.js rather than here, so the check cannot be missed
   * by a future second caller.
   */
  '/activity/run': async body => {
    const entry = await gitConsole.run(body.command);

    return {
      entry,
      entries: commandLog.list({ limit: 150 }),
      status: await readStatus()
    };
  },

  // Apply the remedy offered alongside a translated error.
  '/fix': async body => {
    const message = await routines.applyFix(body.id);
    return { ok: true, summary: message, status: await readStatus() };
  }
};

/**
 * Run a setup step and hand back the refreshed checklist alongside it.
 *
 * `readStatus()` is attempted but not required: half the point of setup is
 * that there is no usable repository yet, so a status failure here is the
 * normal case rather than something to report.
 */
async function withSetup(promise) {
  const result = await promise;
  const setup = await setupService.inspect();

  let status = null;

  try {
    status = await readStatus();
  } catch (err) {
    status = null;
  }

  return Object.assign({}, result, { setup }, status ? { status } : {});
}

// Mutating requests in flight. auto-pull consults this so a background
// pull never runs concurrently with something the user started.
let inFlight = 0;

autoPull.setBusyCheck(() => inFlight > 0);

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;

      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });

    req.on('error', reject);

    req.on('end', () => {
      if (!raw) {
        return resolve({});
      }

      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('request body is not valid JSON'));
      }
    });
  });
}

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The renderer runs on a different origin (file://) than this server.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-git-plugin-token, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(payload);
}

/**
 * Proxy the guiding-questions chat as a server-sent event stream: ask
 * OpenRouter with streaming on, and pipe its SSE straight through to the
 * client. A failure before the stream opens is still reported as ordinary
 * JSON, so the panel can show the reason.
 */
async function handleChatStream(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }

  let upstream;
  try {
    upstream = await aiService.chatStream({
      path: body.path,
      conversation: body.conversation
    });
  } catch (err) {
    return send(res, 200, { error: gitErrors.translate(err).title || err.message });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return send(res, 200, { error: `OpenRouter ${upstream.status}: ${text.slice(0, 200)}` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  upstream.body.on('data', chunk => res.write(chunk));
  upstream.body.on('end', () => res.end());
  upstream.body.on('error', () => { try { res.end(); } catch (e) { /* gone */ } });

  // If the client goes away, stop pulling from OpenRouter.
  req.on('close', () => { try { upstream.body.destroy(); } catch (e) { /* gone */ } });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  // Token may arrive as a header or a query param; the query form is there
  // because it survives the simplest possible fetch() call in the client.
  const token = req.headers['x-git-plugin-token'] || url.searchParams.get('token');

  if (token !== TOKEN) {
    return send(res, 403, { error: 'bad or missing token' });
  }

  // Streaming is handled apart from the JSON route table: it must not be
  // buffered into one response, so the model's words reach the panel as they
  // arrive.
  if (req.method === 'POST' && url.pathname === '/ai/chat/stream') {
    return handleChatStream(req, res);
  }

  const isPost = req.method === 'POST';
  const route = isPost ? postRoutes[url.pathname] : getRoutes[url.pathname];

  if (!route) {
    // Be explicit when the route exists but the verb is wrong - it is the
    // easiest mistake to make against this API.
    if (!isPost && postRoutes[url.pathname]) {
      return send(res, 405, { error: `${url.pathname} requires POST` });
    }

    return send(res, 404, { error: `no such route: ${url.pathname}` });
  }

  // '/auto-pull/now' is excluded: it *is* the auto-pull, so counting it
  // would make its own precondition check report "already busy".
  const counts = isPost && url.pathname !== '/auto-pull/now';

  if (counts) inFlight++;

  try {
    const body = isPost ? await readBody(req) : {};

    send(res, 200, await route(body));
  } catch (err) {
    // Expected conditions - no repo configured, nothing staged, a rejected
    // push - are reported in the body so the panel can show them inline
    // rather than treating them as a transport failure.
    //
    // Everything goes through the translator so the panel never has to
    // render raw git text at a non-technical user.
    const friendly = gitErrors.translate(err);

    send(res, 200, {
      error: friendly.title,
      errorDetail: friendly.detail,
      fix: friendly.fix,
      raw: friendly.raw,
      recognised: friendly.recognised
    });
  } finally {
    if (counts) inFlight--;
  }
}

/**
 * Publish the port + token so the client bundle can find us.
 *
 * This is written as a *script*, not JSON, and the client loads it with a
 * <script> tag rather than fetch(). That is deliberate:
 *
 * `app-plugins://` is not a registered Electron protocol - Modeler simply
 * redirects it to `file://` from a webRequest.onBeforeRequest hook (see
 * lib/index.js). A redirect hook is enough for <script>/<link> tags, which
 * is all Modeler uses it for, but fetch() rejects an unrecognised URL
 * scheme before the redirect ever runs. So fetching this file is
 * impossible; loading it as a script is the supported path.
 *
 * Rewritten on every start, because the token is regenerated each launch.
 */
function publishHandshake() {
  // A second instance - a test, a script - must not overwrite the handshake
  // a running Modeler is relying on. Its token is per-launch, so clobbering
  // the file locks the real panel out of its own bridge until restart.
  if (process.env.CAMUNDA_GIT_BRIDGE_NO_HANDSHAKE) {
    return;
  }

  // Deliberately written *next to the client bundle*. The renderer derives
  // this URL from its own <script> src, so living in the same directory
  // means the client never has to construct a path or guess a URL scheme.
  const dir = path.join(__dirname, '..', 'client', 'dist');
  const file = path.join(dir, 'bridge.js');

  const contents =
    '/* generated by camunda-git-plugin at startup - do not edit */\n' +
    `window.__camundaGitBridge = ${JSON.stringify({ port: PORT, host: HOST, token: TOKEN })};\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
  } catch (err) {
    console.error('[camunda-git-plugin] could not write bridge.js:', err.message);
  }
}

function start() {
  if (server) {
    return { port: PORT, token: TOKEN };
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('[camunda-git-plugin] bridge request failed:', err);
      try {
        send(res, 500, { error: 'internal error' });
      } catch (e) { /* response already sent */ }
    });
  });

  server.on('error', err => {
    console.error(`[camunda-git-plugin] bridge server failed on ${HOST}:${PORT}:`, err.message);
    server = null;
  });

  server.listen(PORT, HOST, () => {
    console.log(`[camunda-git-plugin] bridge listening on http://${HOST}:${PORT}`);
    publishHandshake();
  });

  return { port: PORT, token: TOKEN };
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }

  // Otherwise the interval keeps the process alive after shutdown.
  autoPull.stop();
}

module.exports = {
  start, stop, setComparisonHandler, setReviewHandler, setAiReviewHandler,
  setCatalogPreviewHandler, setUrlOpener, setFolderPicker, setFileOpener,
  PORT, HOST, TOKEN
};
