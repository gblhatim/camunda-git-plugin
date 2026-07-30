/**
 * Client-side (renderer) extension.
 *
 * Contributes three surfaces:
 *   - a branch indicator in the status bar
 *   - a "Source Control" tab in the bottom panel
 *   - a "Diagrams" tab (the file explorer) beside it
 *
 * This module owns the bridge plumbing and all state; the views live in
 * components.js and the styling in styles.css.
 *
 * React and Fill come from the host (window.react / window.components,
 * bound by Modeler before script plugins load) so there is exactly one
 * React instance in the renderer.
 */

import React from 'camunda-modeler-plugin-helpers/vendor/react.js';
import Fill from 'camunda-modeler-plugin-helpers/components/Fill.js';
import { registerClientExtension, registerBpmnJSPlugin } from 'camunda-modeler-plugin-helpers';

import TaskDetailsModule from './task-details.js';
import CatalogInsertModule from './catalog-insert.js';

import {
  Notice,
  BusyBar,
  NextAction,
  Fold,
  SyncWork,
  Workstreams,
  SavePoints,
  SaveMyWork,
  FinishWork,
  RepoContext,
  Setup,
  DetachedNotice,
  ConflictResolver,
  Section,
  Explorer,
  Releases,
  Activity,
  Settings,
  ChangesPane,
  WorkHero,
  MergeRequests,
  Overview,
  SearchDiagrams,
  AiEdit,
  Catalog,
  SubNav
} from './components.js';

import { History } from './history.js';
import { Icon } from './icons.js';

const { useState, useEffect, useCallback, useMemo } = React;
const h = React.createElement;

// Six areas, not eleven flat tabs. Three of them (My Work, Team, Diagrams)
// host a sub-nav; the rest are single-purpose. See the render for the map of
// which old tab became which section.
const MY_WORK_ID = 'git-my-work';   // Now · Changes · History
const TEAM_ID = 'git-team';         // Overview · Requests · Releases
const DIAGRAMS_ID = 'git-diagrams'; // Files · Search · Catalog
const AI_ID = 'git-ai';
const ACTIVITY_ID = 'git-activity';
const SETTINGS_ID = 'git-settings';

/**
 * The tab labels, icon and all.
 *
 * Modeler renders a bottom-panel tab's `label` as a React child - it is
 * `<span className="panel__link-label">{ label }</span>` in its Panel.Tab -
 * so a label can be an element rather than a string, which is how these get
 * icons matching Modeler's own Carbon set.
 *
 * They are built **once, at module scope, on purpose**. Modeler feeds `label`
 * into a `useMemo` whose result drives an `addTab`/`removeTab` effect, so a
 * label element rebuilt on every render would deregister and re-register the
 * tab on every render. A stable identity keeps that effect quiet.
 *
 * `cgp-tablabel` marks these as ours: every stylesheet rule that touches
 * Modeler's tab chrome is scoped through it with `:has()`, so the host's own
 * panels keep their appearance.
 */
function tabLabel(icon, text, extraClass) {
  return h('span', {
    className: `cgp-tablabel${extraClass ? ` ${extraClass}` : ''}`
  },
    h(Icon, { name: icon, size: 15 }),
    text && h('span', { className: 'cgp-tablabel__text' }, text)
  );
}

const TAB_LABELS = {
  myWork: tabLabel('Branch', 'My Work'),
  team: tabLabel('Group', 'Team'),
  diagrams: tabLabel('Document', 'Diagrams'),
  ai: tabLabel('MagicWand', 'AI'),

  // From here the tabs sit at the right-hand end of the strip - they are
  // reference and configuration, not the work itself.
  activity: tabLabel('Activity', 'Activity', 'cgp-tablabel--end'),

  // Icon only: it is configured once and recognised by its gear, so the word
  // is spent screen width. The title carries the name for a screen reader.
  settings: h('span', {
    className: 'cgp-tablabel cgp-tablabel--icon',
    title: 'Git settings',
    'aria-label': 'Git settings'
  }, h(Icon, { name: 'Settings', size: 15 }))
};

/**
 * Flatten the diagram tree to the .bpmn files an AI edit can target.
 */
function flattenDiagrams(treeData) {
  if (!treeData || !treeData.tree) return [];

  const out = [];
  const walk = node => {
    (node.files || []).forEach(f => {
      if (/\.bpmn$/i.test(f.path)) {
        out.push({ path: f.path, title: f.title || f.path.split('/').pop() });
      }
    });
    (node.folders || []).forEach(walk);
  };

  walk(treeData.tree);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
const POLL_MS = 5000;

// ---------------------------------------------------------------- bridge

/**
 * URL of the handshake script, derived from this bundle's own <script> src
 * rather than hardcoded.
 *
 * `fetch()` cannot be used at all: `app-plugins://` is a webRequest
 * redirect rather than a registered protocol, and fetch rejects unknown
 * schemes. A hardcoded `app-plugins://` <script> tag is refused too, by
 * the app's CSP (`script-src 'self'`). But whatever URL Modeler used to
 * load *this* file is by definition allowed - and bridge-server.js writes
 * bridge.js into this same directory.
 */
function resolveHandshakeUrl() {
  const self =
    (document.currentScript && document.currentScript.src) ||
    Array.from(document.getElementsByTagName('script'))
      .map(s => s.src)
      .filter(Boolean)
      .find(src => /client\.js(\?|$)/.test(src));

  if (!self) {
    throw new Error('could not locate own script tag to resolve bridge.js');
  }

  return self.replace(/client\.js(\?.*)?$/, 'bridge.js');
}

// Eager: document.currentScript is only valid during initial execution.
const HANDSHAKE_URL = (() => {
  try {
    return resolveHandshakeUrl();
  } catch (err) {
    console.error('[camunda-git-plugin]', err.message);
    return null;
  }
})();

function readHandshake() {
  if (window.__camundaGitBridge) {
    return Promise.resolve(window.__camundaGitBridge);
  }

  if (!HANDSHAKE_URL) {
    return Promise.reject(new Error('bridge URL could not be resolved'));
  }

  return new Promise((resolve, reject) => {
    const el = document.createElement('script');

    el.src = `${HANDSHAKE_URL}?t=${Date.now()}`;   // token changes per launch
    el.async = false;

    el.onload = () => window.__camundaGitBridge
      ? resolve(window.__camundaGitBridge)
      : reject(new Error('bridge.js loaded but set no globals'));

    el.onerror = () => reject(
      new Error(`cannot load ${el.src} - is the main-process half running?`)
    );

    document.head.appendChild(el);
  });
}

function apiGet({ host, port, token }, route, { timeoutMs } = {}) {
  // An optional client-side deadline. The bridge routes are time-bounded on
  // their own, but a request that hangs below that - a wedged socket, a
  // main process mid-crash - would otherwise leave a tab on "Loading"
  // forever. Aborting turns that into an error the panel can show.
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  return fetch(
    `http://${host}:${port}${route}?token=${encodeURIComponent(token)}`,
    controller ? { signal: controller.signal } : undefined
  )
    .then(res => {
      if (!res.ok) throw new Error(`bridge returned ${res.status}`);
      return res.json();
    })
    .catch(err => {
      if (err.name === 'AbortError') {
        throw new Error('This took too long and was stopped. The team server may be unreachable.');
      }
      throw err;
    })
    .finally(() => { if (timer) clearTimeout(timer); });
}

function apiPost({ host, port, token }, route, body) {
  return fetch(`http://${host}:${port}${route}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(res => {
    if (!res.ok) throw new Error(`bridge returned ${res.status}`);
    return res.json();
  });
}

/**
 * POST that reads a server-sent event stream, calling `onDelta` with each
 * token. Used for the AI chat, so questions appear as they are written. A
 * failure before the stream opens comes back as JSON and is thrown.
 */
async function apiStream({ host, port, token }, route, body, onDelta) {
  const res = await fetch(`http://${host}:${port}${route}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });

  const contentType = res.headers.get('Content-Type') || '';

  if (!contentType.includes('event-stream')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `the chat could not start (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();   // keep the last, possibly-partial line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] &&
          json.choices[0].delta && json.choices[0].delta.content;
        if (delta) { full += delta; if (onDelta) onDelta(full); }
      } catch (err) {
        // A frame split across chunks completes on the next read.
      }
    }
  }

  return full;
}

// ------------------------------------------------------------ status bar

function statusLabel(status) {
  if (!status) {
    return null;
  }

  if (status.detached) {
    return 'an old version · not on a workstream';
  }

  const branch = status.branch || 'no branch';

  if (status.conflictCount) {
    return `${branch} · needs your decision`;
  }

  if (!status.changedTotal) {
    return branch;
  }

  return `${branch} · ${status.changedTotal} ${status.changedTotal === 1 ? 'change' : 'changes'}`;
}

function statusTooltip(status, error) {
  if (error) {
    return `${error}\n\nUse the menu: Git: Repository Settings...`;
  }

  if (!status) {
    return 'Checking your diagrams for changes...';
  }

  const lines = [];

  if (status.conflictCount) {
    lines.push(`${status.conflictCount} diagram(s) need you to choose a version`);
  } else if (status.changedTotal) {
    lines.push(`${status.changedTotal} file(s) changed since your last save point`);
  } else {
    lines.push('No changes - everything is saved');
  }

  if (status.ahead) lines.push(`${status.ahead} save point(s) not yet sent to the team`);
  if (status.behind) lines.push(`${status.behind} update(s) from the team not yet downloaded`);

  lines.push('', 'Click to open Source Control');

  return lines.join('\n');
}

// --------------------------------------------------------- busy labelling

/**
 * What to say while a route is running.
 *
 * Written in the same vocabulary as the button that triggers it - somebody
 * who clicked "Send" should read "Sending your work to the team", not
 * "POST /push" and not "git push". Routes with no entry fall back to a
 * generic label rather than exposing the path.
 *
 * `slow` is the second line, shown only once an operation has been going
 * long enough to worry about, and is set where there is a *specific* reason
 * it might take a while - a clone is large, a first push contacts a server
 * that may be asleep. Everything else gets the generic reassurance.
 */
const BUSY_LABELS = {
  '/stage': { label: 'Including that diagram in your next save point' },
  '/unstage': { label: 'Leaving that diagram out of your next save point' },
  '/stage-all': { label: 'Including everything in your next save point' },
  '/commit': { label: 'Creating a save point' },

  '/push': {
    label: 'Sending your work to the team',
    slow: 'Still sending - this is the network, not your diagrams. Nothing is lost if it fails.'
  },
  '/pull': {
    label: "Getting the team's updates",
    slow: 'Still downloading - large projects take a while over a slow connection or VPN.'
  },

  '/routine/save/preview': { label: 'Working out what would be saved' },
  '/routine/sync/preview': { label: 'Working out what getting in step would do' },
  '/routine/sync/run': {
    label: 'Getting you back in step with the team',
    slow: 'Still going - this gets their work and sends yours, so it is two ' +
      'trips to the server.'
  },
  '/routine/save/run': { label: 'Saving your work' },
  '/routine/finish/preview': { label: 'Working out what finishing would do' },
  '/routine/finish/run': { label: 'Finishing this workstream' },
  '/routine/rollback/preview': { label: 'Working out what would change' },
  '/routine/rollback/run': { label: 'Putting your diagrams back' },

  '/conflict/resolve': { label: 'Applying your decision' },
  '/conflict/combine': { label: 'Combining both versions' },
  '/merge-request/resolve': {
    label: 'Bringing the two branches together so you can resolve them',
    slow: 'Still going - this fetches from the server and starts the merge.'
  },
  '/merge-request/review': {
    label: 'Opening the review',
    slow: 'Still going - this fetches the two branches to compare them.'
  },
  '/ai/edit/preview': {
    label: 'Asking the AI for an edit',
    slow: 'Still thinking - the model is rewriting the diagram.'
  },
  '/ai/edit/apply': { label: 'Applying the AI edit' },
  '/ai/edit/from-chat': {
    label: 'Generating the edit from your conversation',
    slow: 'Still going - the model is writing the whole diagram.'
  },
  '/ai/edit/review': { label: 'Opening the before/after' },
  '/catalog/new': { label: 'Creating the new diagram' },
  '/support/report': { label: 'Compiling the problem report' },
  '/conflict/undo': { label: 'Putting that decision back' },
  '/conflict/compare': { label: 'Opening the two versions' },
  '/merge/complete': { label: 'Finishing up' },
  '/merge/abort': { label: 'Cancelling and putting everything back' },

  '/workstream/switch': { label: 'Switching workstream' },
  '/workstream/create': { label: 'Starting the new workstream' },
  '/workstream/delete': { label: 'Removing that workstream' },
  '/workstream/delete/preview': { label: 'Checking whether that is safe to remove' },

  '/release/start': { label: 'Cutting the release branch' },
  '/release/integrate/preview': { label: 'Checking what releasing would do' },
  '/release/integrate': {
    label: 'Putting it live and bringing it back',
    slow: 'Still going - this merges into two branches and marks the version.'
  },
  '/release/back-merge': { label: 'Bringing the live changes back' },

  '/setup/init': { label: 'Setting this folder up to track changes' },
  '/setup/identity': { label: 'Recording who you are' },
  '/setup/first-save': { label: 'Creating the first save point' },
  '/setup/connect': {
    label: 'Connecting to the team server',
    slow: 'Still waiting for the server to answer. Nothing has been sent.'
  },
  '/setup/clone': {
    label: "Copying the team's project onto this computer",
    slow: 'Still copying - a project with a long history can take several minutes.'
  },
  '/setup/branch': { label: 'Creating that branch' },

  '/project/setup/preview': { label: 'Working out what would be written' },
  '/project/setup/apply': { label: 'Saving the team settings' },

  '/settings': { label: 'Saving your settings' },
  '/settings/pick-folder': { label: 'Opening the folder chooser' },
  '/setup/pick-folder': { label: 'Opening the folder chooser' },
  '/auto-pull/now': { label: 'Checking for updates' },
  '/activity/clear': { label: 'Clearing the log' },
  '/activity/run': { label: 'Running your command' },
  '/fix': { label: 'Applying the fix' }
};

/**
 * Lead actions that open a section rather than running immediately.
 *
 * Anything not in here is a single unambiguous act that just runs. Module
 * scope rather than the component body so the callbacks that close over it
 * are not re-made every render.
 */
// `tidy` opens the workstream list, which is where Remove lives.
const LEAD_SECTIONS = {
  save: 'save', start: 'start', finish: 'finish', sync: 'sync', tidy: 'start'
};

function busyFor(route) {
  const entry = BUSY_LABELS[route] || {};

  return {
    label: entry.label || 'Working',
    slow: entry.slow || null,
    route,
    startedAt: Date.now()
  };
}

// ------------------------------------------------------------------ app

function GitPlugin(props) {
  const { triggerAction, layout } = props;

  const [ bridge, setBridge ] = useState(null);
  const [ status, setStatus ] = useState(null);
  const [ error, setError ] = useState(null);

  // What is running, not merely *that* something is. `busy` stays a plain
  // boolean below so every existing `disabled: busy` keeps working, while
  // the descriptor drives BusyBar.
  const [ pending, setPending ] = useState(null);
  const [ notice, setNotice ] = useState(null);
  const [ conflicts, setConflicts ] = useState([]);
  const [ resolvedFiles, setResolvedFiles ] = useState([]);
  const [ conflictContext, setConflictContext ] = useState(null);
  const [ workstreams, setWorkstreams ] = useState(null);
  const [ tree, setTree ] = useState(null);
  const [ activity, setActivity ] = useState([]);
  const [ consoleEnabled, setConsoleEnabled ] = useState(false);
  const [ history, setHistory ] = useState(null);
  const [ settings, setSettings ] = useState(null);
  const [ projectSetup, setProjectSetup ] = useState(null);
  const [ context, setContext ] = useState(null);
  const [ setup, setSetup ] = useState(null);
  const [ autoPullState, setAutoPullState ] = useState(null);
  const [ blockedReason, setBlockedReason ] = useState(null);
  const [ savePoints, setSavePoints ] = useState(null);
  const [ next, setNext ] = useState(null);
  const [ release, setRelease ] = useState(null);
  const [ releaseChanges, setReleaseChanges ] = useState(null);
  const [ mergeRequests, setMergeRequests ] = useState(null);
  const [ overview, setOverview ] = useState(null);
  const [ catalog, setCatalog ] = useState(null);

  // Which section the user opened, overriding whatever the lead suggests.
  // Null means "follow the lead" - so the panel reorganises itself as the
  // repository changes until somebody says otherwise, and then stays put.
  const [ openSection, setOpenSection ] = useState(null);

  // The sub-nav position inside each of the three multi-section areas.
  const [ workTab, setWorkTab ] = useState('now');
  const [ teamTab, setTeamTab ] = useState('overview');
  const [ diagramsTab, setDiagramsTab ] = useState('files');

  const busy = !!pending;

  // --- polling -----------------------------------------------------------

  // The last revision we reloaded the heavy tabs for. A ref rather than
  // state: it is read inside the poll callback and must not re-create it.
  const revisionRef = React.useRef(null);

  const refresh = useCallback(async bridge => {
    try {
      const next = await apiGet(bridge, '/status');

      if (next.error) {
        setStatus(null);
        setError(next.error);
        return;
      }

      setStatus(next);
      setError(null);

      // Conflict detail costs an extra git call, so only when merging.
      if (next.merging) {
        const data = await apiGet(bridge, '/conflicts');
        setConflicts(data.conflicts || []);
        setResolvedFiles(data.resolved || []);
        setConflictContext(data.context || null);
      } else {
        setConflicts(prev => (prev.length ? [] : prev));
        setResolvedFiles(prev => (prev.length ? [] : prev));
      }

      // Anything that moved the repository - a commit from the console, a
      // pull, a diagram saved by Modeler, a branch made in a terminal -
      // changes this, and the tabs that are not polled catch up.
      if (next.revision && next.revision !== revisionRef.current) {
        const first = revisionRef.current === null;

        revisionRef.current = next.revision;

        if (!first) {
          reloadAll(bridge);
        }
      }
    } catch (err) {
      console.error('[camunda-git-plugin] status fetch failed:', err);
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTree = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      setTree(await apiGet(target, '/tree'));
    } catch (err) {
      console.error('[camunda-git-plugin] tree fetch failed:', err);
      setTree({ error: err.message });
    }
  }, [ bridge ]);

  const loadActivity = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      const data = await apiGet(target, '/activity');
      setActivity(data.entries || []);
      setConsoleEnabled(!!data.consoleEnabled);
    } catch (err) {
      console.error('[camunda-git-plugin] activity fetch failed:', err);
    }
  }, [ bridge ]);

  const loadHistory = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      setHistory(await apiGet(target, '/history'));
    } catch (err) {
      console.error('[camunda-git-plugin] history fetch failed:', err);
      setHistory({ error: err.message });
    }
  }, [ bridge ]);

  // Full detail for one commit - message body, dates, and the files it
  // touched - fetched only when a row in the graph is opened.
  const fetchCommit = useCallback(async hash => {
    if (!bridge) return null;

    const detail = await apiPost(bridge, '/history/commit', { hash });

    if (detail && detail.error) {
      throw new Error(detail.error);
    }

    return detail;
  }, [ bridge ]);

  const loadSavePoints = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      const data = await apiGet(target, '/save-points');
      if (!data.error) setSavePoints(data);
    } catch (err) {
      console.error('[camunda-git-plugin] save points fetch failed:', err);
    }
  }, [ bridge ]);

  const loadNext = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      const data = await apiGet(target, '/next-action');
      if (!data.error) setNext(data);
    } catch (err) {
      console.error('[camunda-git-plugin] next action fetch failed:', err);
    }
  }, [ bridge ]);

  /**
   * The integrator's picture. Loaded like the other heavy routes - on a
   * repository change and on tab activation, never on the status poll.
   */
  const loadRelease = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      const data = await apiGet(target, '/release');

      if (data.error) return;

      setRelease(data);

      // Only worth fetching for a project that has a release train at all.
      if (data.applicable) {
        const list = await apiGet(target, '/release/changes');
        if (!list.error) setReleaseChanges(list);
      }
    } catch (err) {
      console.error('[camunda-git-plugin] release fetch failed:', err);
    }
  }, [ bridge ]);

  /**
   * Open merge/pull requests from the team server. Hits the network (the
   * host's API), so it loads on demand - tab activation and after a
   * refresh - never on the status poll.
   */
  const loadMergeRequests = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      const data = await apiGet(target, '/merge-requests');
      // An error here is normal - no remote, no token, an unrecognised host
      // - and the panel says so rather than looking broken.
      setMergeRequests(data);
    } catch (err) {
      console.error('[camunda-git-plugin] merge requests fetch failed:', err);
      setMergeRequests({ error: err.message });
    }
  }, [ bridge ]);

  /**
   * The team overview. Makes a network call (the merge-request list) and a
   * count per workstream, so it loads on the repository change and on tab
   * activation, never on the status poll.
   */
  const loadOverview = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      // 25s: comfortably past the server's own 12s backstop, so a normal
      // slow-but-working response is never cut off, but a true hang still
      // ends in a visible error instead of an endless spinner.
      setOverview(await apiGet(target, '/overview', { timeoutMs: 25000 }));
    } catch (err) {
      console.error('[camunda-git-plugin] overview fetch failed:', err);
      setOverview({ error: err.message, rows: [] });
    }
  }, [ bridge ]);

  /**
   * The shipped BPMN patterns. Static, so it needs no repository - loaded
   * once and on tab activation.
   */
  const loadCatalog = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      setCatalog(await apiGet(target, '/catalog'));
    } catch (err) {
      console.error('[camunda-git-plugin] catalog fetch failed:', err);
      setCatalog({ error: err.message, entries: [] });
    }
  }, [ bridge ]);

  const loadSettings = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;
    try {
      const data = await apiGet(target, '/settings');
      if (data.error) return;
      setSettings(data.settings);
      setAutoPullState(data.autoPull);
      setBlockedReason(data.blockedReason);

      // Needs a repository, so it fails on a machine with none configured -
      // which is exactly when the rest of Settings still has to render.
      const setup = await apiGet(target, '/project/setup');
      setProjectSetup(setup.error ? null : setup);
    } catch (err) {
      console.error('[camunda-git-plugin] settings fetch failed:', err);
    }
  }, [ bridge ]);

  const loadWorkstreams = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      const data = await apiGet(target, '/workstreams');
      if (!data.error) setWorkstreams(data);
    } catch (err) {
      console.error('[camunda-git-plugin] workstream fetch failed:', err);
    }
  }, [ bridge ]);

  /**
   * The setup checklist. Loaded before anything else can be trusted: until
   * there is a repository with a commit in it, every other route reports an
   * error that says nothing useful.
   */
  const loadSetup = useCallback(async b => {
    const target = b || bridge;
    if (!target) return null;

    try {
      const data = await apiGet(target, '/setup');
      setSetup(data.error ? null : data);
      return data;
    } catch (err) {
      console.error('[camunda-git-plugin] setup fetch failed:', err);
      return null;
    }
  }, [ bridge ]);

  const loadContext = useCallback(async b => {
    const target = b || bridge;
    if (!target) return;

    try {
      const data = await apiGet(target, '/context');
      setContext(data.error ? null : data);
    } catch (err) {
      console.error('[camunda-git-plugin] context fetch failed:', err);
    }
  }, [ bridge ]);

  /**
   * Everything that is not on the status poll.
   *
   * Fired when the repository has actually changed rather than on a timer:
   * these are the expensive routes, and reloading them every few seconds
   * would put a `git log` and a `git ls-files` behind every tick for a
   * panel nobody is looking at.
   */
  const reloadAll = useCallback(b => {
    const target = b || bridge;
    if (!target) return;

    loadTree(target);
    loadHistory(target);
    loadSavePoints(target);
    loadWorkstreams(target);
    loadActivity(target);
    loadContext(target);
    loadNext(target);

    // Must be here, not only on tab activation: the Releases tab is
    // rendered *from* this state, so loading it lazily when the tab is
    // opened means the tab never appears to be opened in the first place.
    loadRelease(target);
    loadMergeRequests(target);
    loadOverview(target);
    loadCatalog(target);
  }, [
    bridge, loadTree, loadHistory, loadSavePoints, loadWorkstreams,
    loadActivity, loadContext, loadNext, loadRelease, loadMergeRequests,
    loadOverview, loadCatalog
  ]);

  useEffect(() => {
    let timer = null;
    let cancelled = false;

    (async () => {
      let b;

      try {
        b = await readHandshake();
      } catch (err) {
        console.error('[camunda-git-plugin] handshake failed:', err);
        if (!cancelled) setError(err.message);
        return;
      }

      if (cancelled) return;

      setBridge(b);
      await refresh(b);

      // Workstreams and the file tree change far less often than status,
      // so they load once and refresh only after a relevant action.
      // Setup first: if the project is not usable yet, the rest of these
      // will fail, and the checklist is what the user needs to see anyway.
      const state = await loadSetup(b);

      if (state && state.ready === false) {
        timer = setInterval(() => { refresh(b); loadSetup(b); }, POLL_MS);
        return;
      }

      await Promise.all([
        loadWorkstreams(b), loadTree(b), loadSettings(b),
        loadActivity(b), loadHistory(b), loadContext(b), loadSavePoints(b),
        loadNext(b), loadRelease(b), loadMergeRequests(b), loadOverview(b),
        loadCatalog(b)
      ]);

      timer = setInterval(() => refresh(b), POLL_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ refresh ]);

  /**
   * Catch up when the window comes back.
   *
   * The poll keeps running while Modeler is in the background, but the
   * interesting case is the user who went to a terminal, committed
   * something, and came back - they expect the panel to already know. The
   * status poll would notice within five seconds; doing it on focus makes
   * it feel immediate rather than laggy.
   */
  useEffect(() => {
    if (!bridge) return undefined;

    const onFocus = () => {
      if (!document.hidden) refresh(bridge);
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [ bridge, refresh ]);

  /**
   * Refresh the tab the user just switched to.
   *
   * The revision stamp covers everything that changed the *repository*, but
   * not things that changed outside it - a settings file edited by hand, a
   * branch pushed by someone else and then fetched. Reloading on tab
   * activation costs one request at the moment attention moves, which is
   * exactly when a stale panel is most noticeable.
   */
  const activeTab = layout && layout.panel && layout.panel.tab;
  const panelOpen = !!(layout && layout.panel && layout.panel.open);

  useEffect(() => {
    if (!bridge || !panelOpen) return;

    const load = {
      [MY_WORK_ID]: () => {
        refresh(bridge); loadWorkstreams(bridge); loadContext(bridge);
        loadSavePoints(bridge); loadNext(bridge); loadHistory(bridge);
      },
      [TEAM_ID]: () => {
        refresh(bridge); loadOverview(bridge); loadMergeRequests(bridge); loadRelease(bridge);
      },
      [DIAGRAMS_ID]: () => { loadTree(bridge); loadCatalog(bridge); },
      [ACTIVITY_ID]: () => loadActivity(bridge),
      [SETTINGS_ID]: () => { loadSettings(bridge); loadContext(bridge); }
    }[activeTab];

    if (load) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ bridge, activeTab, panelOpen ]);

  // --- actions -----------------------------------------------------------

  /**
   * Run a mutating route and adopt whatever it returns.
   *
   * `busy` disables the panel throughout: git operations are not safe to
   * interleave, and a double-clicked commit is a real hazard.
   *
   * Returns the response on success and null on failure. Callers that only
   * need "did it work" still read it as a boolean, but the routines need
   * the per-step outcomes - a partial success, where the save worked and
   * the send did not, is the case worth reporting accurately.
   */
  const act = useCallback(async (route, body, successText) => {
    if (!bridge) return null;

    setPending(busyFor(route));
    setNotice(null);

    try {
      const res = await apiPost(bridge, route, body);

      if (res.error) {
        setNotice({
          type: 'error',
          text: res.error,
          detail: res.errorDetail,
          fix: res.fix,
          raw: res.raw,
          recognised: res.recognised
        });
        return null;
      }

      if (res.status) { setStatus(res.status); setError(null); }
      if (res.conflicts) setConflicts(res.conflicts);
      if (res.resolved) setResolvedFiles(res.resolved);
      if (res.context) setConflictContext(res.context);
      if (res.workstreams) setWorkstreams(res.workstreams);
      if (res.entries) setActivity(res.entries);
      // Only the personal settings shape is adopted here. Several routes
      // legitimately return something called `settings`, and swallowing the
      // wrong one replaces this object with a partial that the Settings tab
      // then renders against.
      if (res.settings && res.settings.autoPull) setSettings(res.settings);
      if (res.autoPull) setAutoPullState(res.autoPull);

      const text = res.summary || successText;
      if (text) setNotice({ type: 'success', text });

      return res;
    } catch (err) {
      console.error(`[camunda-git-plugin] ${route} failed:`, err);
      setNotice({ type: 'error', text: err.message });
      return null;
    } finally {
      setPending(null);
    }
  }, [ bridge ]);

  /**
   * A read-only POST - the routine previews - with the same busy reporting.
   *
   * They went straight to `apiPost` before, so the panel showed nothing at
   * all while they ran. That is fine for a preview that returns instantly
   * and confusing for `planRollback`, which runs two `git log`s and a diff
   * against an old commit. Unlike `act` this adopts nothing from the
   * response and never sets a notice: a preview is a question, and its
   * answer belongs in the component that asked.
   */
  const peek = useCallback(async (route, body) => {
    if (!bridge) return null;

    setPending(busyFor(route));

    try {
      return await apiPost(bridge, route, body);
    } catch (err) {
      console.error(`[camunda-git-plugin] ${route} failed:`, err);
      return { possible: false, reason: err.message };
    } finally {
      setPending(null);
    }
  }, [ bridge ]);

  /**
   * Take the checklist a setup step handed back.
   *
   * When that step is the one that makes the project usable - the first
   * save point, or a clone - everything else loads for the first time.
   */
  const adoptSetup = useCallback(res => {
    if (!res || !res.setup) return;

    setSetup(res.setup);

    if (res.setup.ready) {
      reloadAll();
      loadSettings();
    }
  }, [ reloadAll, loadSettings ]);

  const pickFolderPath = useCallback(async () => {
    const res = await peek('/setup/pick-folder');

    return res && res.path ? res.path : null;
  }, [ peek ]);

  const actions = useMemo(() => ({
    stage: file => act('/stage', { path: file.path }).then(() => loadTree()),
    unstage: file => act('/unstage', { path: file.path }),
    stageAll: () => act('/stage-all'),
    commit: message => act('/commit', { message }, 'Save point created.').then(() => { loadTree(); loadHistory(); }),
    push: () => act('/push', {}, 'Sent to the team.'),
    pull: () => act('/pull', {}, 'Updates downloaded.').then(() => loadTree()),

    previewSave: () => peek('/routine/save/preview'),
    runSave: async message => {
      const res = await act('/routine/save/run', { message });
      reloadAll();

      return res || { ok: false, steps: [], summary: '' };
    },

    previewSync: () => peek('/routine/sync/preview'),
    runSync: async () => {
      const res = await act('/routine/sync/run');
      reloadAll();

      return res || { ok: false, steps: [], summary: '' };
    },

    previewFinish: () => peek('/routine/finish/preview'),
    runFinish: async () => {
      const res = await act('/routine/finish/run');
      reloadAll();

      return res || { ok: false, steps: [], summary: '' };
    },

    // Reproduce a merge request's conflicts locally and hand off to the
    // resolver. On success the working tree is mid-merge, so the resolver
    // lives in Source Control - take the user there rather than leaving
    // them on the list wondering where the diagrams went.
    // --- catalog -------------------------------------------------------
    // Create returns the new file's path; the component opens it via onOpen.
    catalogNew: (id, name) =>
      act('/catalog/new', { id, name }, 'New diagram created from the catalog.')
        .then(res => { loadTree(); return res; }),
    catalogPreview: id => act('/catalog/preview', { id }),

    // --- support -------------------------------------------------------
    // Drafts a mail with logs attached and opens it; never sends.
    reportProblem: async () => {
      const res = await act('/support/report');
      if (res) {
        setNotice({
          type: 'success',
          text: res.opened
            ? 'A problem report opened in your mail client with the logs attached - review it and send.'
            : `A problem report was saved to ${res.dir}. Your mail client did not open automatically; ` +
              'attach those files to an email yourself.'
        });
      }
      return res;
    },

    // --- AI edits ------------------------------------------------------
    aiPreview: (path, instruction) => act('/ai/edit/preview', { path, instruction }),
    // The guiding-questions chat, streamed. onDelta gets the full text so far.
    aiChat: (path, conversation, onDelta) =>
      (bridge
        ? apiStream(bridge, '/ai/chat/stream', { path, conversation }, onDelta)
        : Promise.reject(new Error('Not connected.'))),
    // Turn the conversation into an edit and preview it.
    aiGenerate: (path, messages) => act('/ai/edit/from-chat', { path, messages }),
    aiApply: path =>
      act('/ai/edit/apply', { path }, 'Applied - saved as a change in Source Control.')
        .then(res => { loadTree(); return res; }),
    aiReview: path => act('/ai/edit/review', { path }),
    aiDiscard: path => (bridge ? apiPost(bridge, '/ai/edit/discard', { path }) : Promise.resolve()),
    aiModels: () => (bridge ? apiPost(bridge, '/ai/models', {}) : Promise.resolve({ models: [] })),
    setModel: model =>
      act('/settings', { openRouterModel: model }, 'Model saved.').then(() => loadSettings()),

    // Semantic search across the whole corpus. Its own path rather than
    // `act`, so typing does not raise the busy bar or a success notice; the
    // Search component shows its own progress.
    search: query =>
      (bridge ? apiPost(bridge, '/search', { query })
        : Promise.resolve({ groups: [], totalHits: 0, filesSearched: 0 })),

    refreshMergeRequests: () => loadMergeRequests(),
    refreshOverview: () => loadOverview(),
    // Opens the visual review window (all changed files, before/after,
    // synced zoom) in the main process.
    reviewMr: (source, target) => act('/merge-request/review', { source, target }),
    // Opens in the real browser via the main process; deliberately not
    // through `act`, so it raises no busy bar or success notice for what is
    // just following a link.
    openUrl: url => (bridge ? apiPost(bridge, '/open-url', { url }) : Promise.resolve()),
    resolveMr: async (source, target) => {
      const res = await act('/merge-request/resolve', { source, target });
      if (!res) return null;

      reloadAll();

      if (res.hasConflicts) {
        setNotice({
          type: 'success',
          text: 'Both branches are open together. Resolve each diagram below, ' +
            'then Finish and Send - that updates the merge request.'
        });

        if (typeof triggerAction === 'function') {
          triggerAction('open-panel', { tab: MY_WORK_ID });
        }
      } else if (res.upToDate) {
        setNotice({
          type: 'success',
          text: 'Nothing to resolve - your branch already has the target\'s changes. ' +
            'Send it and the merge request will be mergeable.'
        });
      }

      return res;
    },

    // Going back to an earlier save point. The run adds a save point rather
    // than removing any, so the list it hands back is the authority on what
    // the workstream now looks like.
    previewRollback: sha => peek('/routine/rollback/preview', { sha }),
    runRollback: async sha => {
      const res = await act('/routine/rollback/run', { sha });
      reloadAll();

      return res || { ok: false, steps: [], summary: '' };
    },

    resolve: (path, keep) => act('/conflict/resolve', { path, keep }),
    // Fold both sides into one diagram instead of discarding a side. The
    // tree reloads because a diagram's contents changed on disk, not just
    // its staged/unstaged state.
    combine: path =>
      act('/conflict/combine', { path }).then(res => { loadTree(); return res; }),
    undoResolution: path =>
      act('/conflict/undo', { path }, 'That file needs a decision again.'),
    compare: path => act('/conflict/compare', { path }),

    // Wording stays neutral about *what* completed: this is a merge most of
    // the time, but a rebase or cherry-pick left open by the console lands
    // here too, and "combined" would be wrong for those.
    completeMerge: () =>
      act('/merge/complete', {}, 'Done. Everything is back together.')
        .then(res => { reloadAll(); return res; }),
    abortMerge: () =>
      act('/merge/abort', {}, 'Cancelled. Nothing was changed.')
        .then(res => { reloadAll(); return res; }),

    switchWorkstream: name =>
      act('/workstream/switch', { name }).then(() => { loadTree(); loadHistory(); }),
    // Accepts either { type, ticket, title } or a bare title, matching the
    // main-process side - a project with no team settings has no types.
    createWorkstream: request =>
      act('/workstream/create', typeof request === 'string' ? { title: request } : request)
        .then(() => { loadTree(); loadHistory(); }),

    // --- releases --------------------------------------------------------
    //
    // Each of these moves both long-lived branches, so everything reloads
    // rather than guessing which parts of the picture changed.

    startRelease: version =>
      act('/release/start', { version }).then(res => {
        loadRelease(); reloadAll();
        return res || {};
      }),

    // Start an urgent fix from the Releases tab. It is a normal hotfix
    // workstream underneath - the same /workstream/create the main form uses,
    // with the type fixed - but starting it from here means the integrator
    // never has to leave for the workstream panel and back. Reloads the
    // release picture so the tab flips straight into "put it live" mode.
    startHotfix: ({ title, ticket }) =>
      act('/workstream/create', { type: 'hotfix', title, ticket })
        .then(res => {
          loadRelease(); reloadAll();

          if (!res || !res.created) {
            return res || {};
          }

          return {
            ok: true,
            summary:
              `Urgent fix "${res.title}" started from what is live. Fix it and ` +
              'save, then release it from here - it goes live and comes back ' +
              'into everyday work, both, so the next release does not undo it.'
          };
        }),

    previewIntegrate: body => peek('/release/integrate/preview', body),

    integrateRelease: body =>
      act('/release/integrate', body).then(res => {
        loadRelease(); reloadAll();
        return res || {};
      }),

    backMerge: () =>
      act('/release/back-merge').then(res => {
        loadRelease(); reloadAll();
        return res || {};
      }),

    previewRemoveWorkstream: name => peek('/workstream/delete/preview', { name }),
    removeWorkstream: (name, opts) =>
      act('/workstream/delete', Object.assign({ name }, opts))
        .then(res => { loadSavePoints(); loadHistory(); loadNext(); return res; }),

    // --- setup ---------------------------------------------------------
    //
    // Each returns the refreshed checklist from the main process, so the
    // panel never guesses that the step it just ran is now done.

    initRepository: () => act('/setup/init').then(res => { adoptSetup(res); return res; }),
    setIdentity: who => act('/setup/identity', who).then(res => { adoptSetup(res); return res; }),
    createFirstSavePoint: message =>
      act('/setup/first-save', { message }).then(res => { adoptSetup(res); return res; }),
    connectRemote: url =>
      act('/setup/connect', { url }).then(res => { adoptSetup(res); return res; }),
    createSetupBranch: name =>
      act('/setup/branch', { name }).then(res => { adoptSetup(res); return res; }),

    cloneProject: async url => {
      // The copy needs somewhere to live; ask before anything is downloaded.
      const parent = await pickFolderPath();

      if (!parent) return null;

      const res = await act('/setup/clone', { url, parentDir: parent });
      adoptSetup(res);
      return res;
    },

    previewProjectSetup: draft => peek('/project/setup/preview', draft),
    applyProjectSetup: settings =>
      act('/project/setup/apply', settings).then(() => {
        loadSettings(); loadWorkstreams(); loadTree();
      }),

    applyFix: id => act('/fix', { id }).then(() => loadTree()),

    saveSettings: patch => act('/settings', patch, 'Settings saved.').then(() => loadSettings()),
    pickFolder: () => act('/settings/pick-folder').then(() => {
      loadSetup(); loadSettings(); loadTree(); loadWorkstreams();
    }),
    autoPullNow: () => act('/auto-pull/now').then(() => { loadSettings(); loadActivity(); }),
    clearActivity: () => act('/activity/clear').then(() => loadActivity()),

    /**
     * A typed command can change anything - branch, files, history, even
     * the remote - so everything reloads rather than guessing what moved.
     *
     * A git command that exits non-zero is *not* an error here: it answered,
     * and the transcript shows the answer. Only being unable to run it at
     * all surfaces as a notice.
     */
    runCommand: command =>
      act('/activity/run', { command }).then(ok => {
        loadTree(); loadHistory(); loadWorkstreams();
        return ok;
      })
  }), [
    act, peek, bridge, reloadAll, adoptSetup, pickFolderPath,
    loadTree, loadSettings, loadActivity, loadWorkstreams, loadHistory,
    loadContext, loadSetup, loadSavePoints, loadMergeRequests, loadOverview, triggerAction
  ]);

  const openDiagram = useCallback(file => {
    if (typeof triggerAction !== 'function' || !tree || !tree.repoPath) {
      return;
    }

    // Modeler's own callers pass an absolute path:
    //   onOpen: e => triggerAction('open-diagram', { path: e })
    const separator = tree.repoPath.includes('\\') ? '\\' : '/';
    const full = tree.repoPath + separator + file.path.split('/').join(separator);

    triggerAction('open-diagram', { path: full });
  }, [ triggerAction, tree ]);

  // --- render ------------------------------------------------------------

  // `ready` means there is a repository with a history - the point from
  // which every other route returns something meaningful. Until the
  // checklist has loaded, assume ready so a slow first request does not
  // flash the setup screen at someone whose project is fine.
  const setupReady = !setup || setup.ready !== false;

  const merging = !!(status && status.merging);
  const files = (status && status.files) || [];

  const openPanel = useCallback(() => {
    if (typeof triggerAction !== 'function') {
      console.error('[camunda-git-plugin] no triggerAction prop - cannot open the panel');
      return;
    }
    triggerAction('open-panel', { tab: MY_WORK_ID });
  }, [ triggerAction ]);

  const text = statusLabel(status);

  // --- which section is open -------------------------------------------

  /**
   * The lead action decides what is open until the user decides otherwise.
   *
   * `openSection` starts null, meaning "follow the lead" - so the panel
   * rearranges itself as the repository changes (save, then send, then
   * finish) without anyone clicking. The moment somebody opens something
   * themselves it holds still, because a panel that re-folds the section you
   * just opened, because a poll changed the answer underneath you, is worse
   * than one that is occasionally showing the wrong thing.
   */
  const leadId = next && next.action ? next.action.id : null;

  const section = openSection !== null ? openSection : LEAD_SECTIONS[leadId] || null;

  const toggleSection = useCallback(id => {
    setOpenSection(current => {
      const showing = current !== null ? current : (LEAD_SECTIONS[leadId] || null);

      // '' rather than null: null means "follow the lead", so closing the
      // section the lead suggested would immediately reopen it.
      return showing === id ? '' : id;
    });
  }, [ leadId ]);

  /**
   * A choice made on the lead card.
   *
   * Two kinds: the ones that *are* a routine open its section and let the
   * routine's own preview/confirm take over, and the ones that are a single
   * unambiguous act (get updates, send) just run - they already report
   * through the busy bar and the notice, and making somebody expand a
   * section to press a second button would be ceremony for its own sake.
   */
  const chooseSection = useCallback(id => {
    if (id === 'update') return actions.pull();
    if (id === 'send') return actions.push();
    if (id === 'detached') return actions.applyFix('return-to-workstream');

    return setOpenSection(id);
  }, [ actions ]);

  const syncSummary = (() => {
    const f = next && next.facts;

    if (!f) return null;
    if (!f.hasRemote) return 'no team server';

    const parts = [];

    if (f.behind) parts.push(`${f.behind} to get`);

    // Counted separately from `behind`, which only ever sees this branch's
    // own copy on the server - see next-action.js.
    if (f.behindBase) parts.push(`${f.behindBase} behind ${f.base}`);
    if (f.ahead) parts.push(`${f.ahead} to send`);
    if (f.neverSent) parts.push('never sent');

    return parts.length ? parts.join(', ') : 'in step';
  })();

  const workstreamSummary = (() => {
    if (!workstreams) return null;

    const streams = workstreams.streams || [];
    const current = streams.find(s => s.isCurrent);
    const others = streams.length - (current ? 1 : 0);

    return [
      current ? current.title : 'not on a workstream',
      others ? `${others} other${others === 1 ? '' : 's'}` : null
    ].filter(Boolean).join(' · ');
  })();

  // --- sub-nav within the three multi-section areas --------------------

  const workItems = [
    { id: 'now', label: 'Now' },
    { id: 'changes', label: 'Changes', badge: files.length || null },
    { id: 'history', label: 'History' }
  ];

  // The Releases section only exists for a project with a release train;
  // when there is none the pill is dropped and a stray `teamTab === 'releases'`
  // falls back to Overview rather than showing an empty tab.
  const releaseApplicable = !!(release && release.applicable);
  const mrCount = mergeRequests && mergeRequests.items ? mergeRequests.items.length : null;

  const teamItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'requests', label: 'Requests', badge: mrCount }
  ].concat(releaseApplicable ? [ { id: 'releases', label: 'Releases' } ] : []);

  const teamSection = (teamTab === 'releases' && !releaseApplicable) ? 'overview' : teamTab;

  // What the Team tab's badge counts: the things a coordinator has to act on.
  const teamAttention = (() => {
    const s = overview && overview.summary;
    if (!s) return 0;

    return (s.conflicting || 0) + (s.stale || 0);
  })();

  const diagramsItems = [
    { id: 'files', label: 'Files' },
    { id: 'search', label: 'Search' },
    { id: 'catalog', label: 'Catalog' }
  ];

  // Switching a sub-tab refreshes just that section's data, so a section the
  // user has not looked at in a while is current the moment they open it.
  const selectWorkTab = id => {
    setWorkTab(id);
    if (id === 'history') loadHistory();
    else if (id === 'now') { refresh(bridge); loadNext(); loadWorkstreams(); loadSavePoints(); }
    else if (id === 'changes') { refresh(bridge); loadContext(); }
  };

  const selectTeamTab = id => {
    setTeamTab(id);
    if (id === 'overview') loadOverview();
    else if (id === 'requests') loadMergeRequests();
    else if (id === 'releases') loadRelease();
  };

  const selectDiagramsTab = id => {
    setDiagramsTab(id);
    if (id === 'files') loadTree();
    else if (id === 'catalog') loadCatalog();
  };

  const currentWorkTitle = (() => {
    const cur = workstreams && (workstreams.streams || []).find(s => s.isCurrent);
    if (cur) return cur.title;
    const branch = status && status.current;
    return branch && branch !== 'HEAD' ? branch : 'an old version';
  })();

  // The notice, shown once in an area's fixed strip above its sub-nav body.
  const noticeStrip = notice && h('div', { className: 'cgp-area__notice' },
    h(Notice, { notice, busy, onFix: actions.applyFix })
  );

  return h(React.Fragment, null,

    // ---- status bar ----
    //
    // The busy state shows here too, because the panel is closed most of the
    // time. Someone who hit "Save my work" and switched back to their
    // diagram has no other way to tell whether it finished.
    h(Fill, { slot: 'status-bar__app', group: '9_git' },
      h('button', {
        className: 'btn',
        title: pending
          ? `${pending.label}...`
          : statusTooltip(status, error),
        onClick: openPanel
      }, pending
        ? h('span', null,
          h('span', { className: 'cgp-spinner cgp-spinner--inline', 'aria-hidden': 'true' }),
          pending.label
        )
        : (text ? `⎇ ${text}` : (error ? '⎇ Not set up' : '⎇ …')))
    ),

    // =====================================================================
    // Six areas, not eleven tabs.
    //
    //   My Work    Now · Changes · History     (was: My work + Source Control)
    //   Team       Overview · Requests · Releases
    //   Diagrams   Files · Search · Catalog
    //   AI, Activity, Settings                 (single-purpose)
    //
    // The three multi-section areas share one shape: a fixed strip (busy
    // bar, sub-nav, notice) above a single scrolling section. Priorities
    // descend by ten so the order is explicit and leaves room to insert.
    // =====================================================================

    // ---- My Work ----
    //
    // The individual's daily loop. Setup and a half-finished merge each take
    // over the whole area: offering "Save my work" mid-conflict is how people
    // get truly stuck, and this is the area they land on.
    h(Fill, {
      slot: 'bottom-panel', id: MY_WORK_ID, label: TAB_LABELS.myWork, layout,
      priority: 60,
      // Modeler draws this as its own badge next to the label.
      number: files.length || undefined
    },
      h('div', { className: 'cgp-area' },
        h('div', { className: 'cgp-area__top' },
          h(BusyBar, { pending }),
          setupReady && !merging && h(SubNav, {
            items: workItems, active: workTab, onSelect: selectWorkTab
          }),
          noticeStrip
        ),

        h('div', { className: 'cgp-area__body' + (busy ? ' cgp-busy' : '') },
          !setupReady
            ? h('div', { className: 'cgp-panel' }, h(Setup, { setup, actions, busy }))

            : merging
              ? h('div', { className: 'cgp-panel' },
                h(ConflictResolver, {
                  conflicts, resolved: resolvedFiles, actions, busy, context: conflictContext
                })
              )

              : workTab === 'changes'
                ? h('div', { className: 'cgp-panel' },
                  h(DetachedNotice, { status, actions, busy }),

                  // Say why the list is empty rather than showing a blank
                  // tab: without this an unreadable repository looks like a
                  // project with no changes in it.
                  error && h('div', { className: 'cgp-notice cgp-notice--warn' },
                    h('div', { className: 'cgp-notice__title' }, 'Could not read your changes'),
                    h('div', { className: 'cgp-notice__body' }, error)
                  ),

                  !error && status && h(React.Fragment, null,
                    h(RepoContext, { context, busy, onRefresh: () => loadContext() }),

                    h('div', { className: 'cgp-toolbar' },
                      h('span', { className: 'cgp-toolbar__spacer' }),
                      h('button', {
                        className: 'btn cgp-btn', disabled: busy,
                        title: status.behind
                          ? `Download ${status.behind} update(s) from the team`
                          : 'Check for updates from the team',
                        onClick: actions.pull
                      }, status.behind ? `Get updates (${status.behind})` : 'Get updates'),
                      h('button', {
                        className: 'btn cgp-btn', disabled: busy,
                        title: status.ahead
                          ? `Send ${status.ahead} save point(s) to the team`
                          : 'Send your save points to the team',
                        onClick: actions.push
                      }, status.ahead ? `Send (${status.ahead})` : 'Send')
                    ),

                    h('hr', { className: 'cgp-divider' }),
                    h(ChangesPane, { status, actions, busy })
                  )
                )

                : workTab === 'history'
                  ? h('div', { className: 'cgp-panel' },
                    h(History, { history, busy, onRefresh: () => loadHistory(), fetchCommit })
                  )

                  // 'now' - the lead action and everything it opens, with the
                  // workstream's story in the aside the wide panel affords.
                  : h('div', { className: 'cgp-panel' },
                    h('div', { className: 'cgp-split cgp-split--work' },
                      h('div', { className: 'cgp-split__main' },
                        h(DetachedNotice, { status, actions, busy }),

                        h(WorkHero, {
                          label: "You're working on",
                          title: currentWorkTitle,
                          status
                        }),

                        h(NextAction, {
                          next, busy, chosen: section, onChoose: chooseSection
                        }),

                        h(Fold, {
                          title: 'Save my work',
                          summary: files.length
                            ? `${files.length} unsaved ${files.length === 1 ? 'change' : 'changes'}`
                            : 'nothing to save',
                          open: section === 'save',
                          onToggle: () => toggleSection('save')
                        }, h(SaveMyWork, { actions, busy, disabled: !files.length })),

                        h(Fold, {
                          title: 'Get in step with the team',
                          summary: syncSummary,
                          open: section === 'sync',
                          onToggle: () => toggleSection('sync')
                        }, h(SyncWork, { actions, busy })),

                        h(Fold, {
                          title: 'Workstreams',
                          summary: workstreamSummary,
                          open: section === 'start',
                          onToggle: () => toggleSection('start')
                        }, h(Workstreams, { workstreams, actions, busy })),

                        h(Fold, {
                          title: 'Finish this workstream',
                          summary: next && next.facts && next.facts.unmerged
                            ? `${next.facts.unmerged} save point(s) to hand over`
                            : 'nothing to hand over yet',
                          open: section === 'finish',
                          onToggle: () => toggleSection('finish')
                        }, h(FinishWork, { actions, busy, workstreams }))
                      ),

                      h('div', { className: 'cgp-split__aside' },
                        h('p', { className: 'cgp-split__title' }, 'Earlier versions'),
                        h(SavePoints, { savePoints, actions, busy })
                      )
                    )
                  )
        )
      )
    ),

    // ---- Team ----
    //
    // The coordinator's space. Overview and Requests are two views of one
    // thing - workstream-centric and request-centric - which is why they are
    // sections here rather than the rival top-level tabs they used to be.
    h(Fill, {
      slot: 'bottom-panel', id: TEAM_ID, label: TAB_LABELS.team, layout,
      priority: 50,
      // What needs a coordinator, not how much exists: a conflicting request
      // or a workstream that has gone quiet. A badge that only ever counted
      // open requests would sit at a permanent non-zero for a busy team and
      // stop meaning anything.
      number: teamAttention || undefined
    },
      h('div', { className: 'cgp-area' },
        h('div', { className: 'cgp-area__top' },
          h(BusyBar, { pending }),
          h(SubNav, { items: teamItems, active: teamSection, onSelect: selectTeamTab }),
          noticeStrip
        ),

        h('div', { className: 'cgp-area__body' + (busy ? ' cgp-busy' : '') },
          teamSection === 'requests'
            ? h('div', { className: 'cgp-panel' },
              // An ordinary git remote (or none) has no requests to list, so
              // this says why rather than rendering an empty board.
              mergeRequests && !mergeRequests.supported && !mergeRequests.error
                ? h('p', { className: 'cgp-empty' },
                  `The team server (${mergeRequests.host || 'this host'}) is not GitHub or ` +
                  'GitLab, so merge requests are not available here.')
                : h(MergeRequests, { data: mergeRequests, actions, busy })
            )

            : teamSection === 'releases'
              ? h('div', { className: 'cgp-panel' },
                h(Releases, { release, changes: releaseChanges, actions, busy })
              )

              : h('div', { className: 'cgp-panel' },
                h(Overview, {
                  data: overview,
                  actions,
                  busy,
                  onOpenTicket: url => actions.openUrl(url)
                })
              )
        )
      )
    ),

    // ---- Diagrams ----
    //
    // Find one, search inside them all, or start a new one from a pattern:
    // three tabs that were always the same job.
    h(Fill, {
      slot: 'bottom-panel', id: DIAGRAMS_ID, label: TAB_LABELS.diagrams, layout,
      priority: 40
    },
      h('div', { className: 'cgp-area' },
        h('div', { className: 'cgp-area__top' },
          h(BusyBar, { pending }),
          h(SubNav, { items: diagramsItems, active: diagramsTab, onSelect: selectDiagramsTab }),
          noticeStrip
        ),

        h('div', { className: 'cgp-area__body' + (busy ? ' cgp-busy' : '') },
          diagramsTab === 'search'
            ? h(SearchDiagrams, {
              search: actions.search,
              onOpen: relPath => openDiagram({ path: relPath })
            })

            : diagramsTab === 'catalog'
              ? h('div', { className: 'cgp-panel' },
                h(Catalog, {
                  catalog,
                  actions,
                  busy,
                  onOpen: relPath => openDiagram({ path: relPath }),
                  // Reaches the active editor's bpmn-js module
                  // (catalog-insert.js) through Modeler's action routing.
                  onInsert: typeof triggerAction === 'function'
                    ? xml => triggerAction('catalog.insert', { xml })
                    : null
                })
              )

              : h(Explorer, {
                tree,
                busy,
                onOpen: openDiagram,
                onRefresh: () => loadTree()
              })
        )
      )
    ),

    // ---- AI ----
    h(Fill, {
      slot: 'bottom-panel', id: AI_ID, label: TAB_LABELS.ai, layout, priority: 30
    },
      h('div', { className: 'cgp-panel' },
        h(BusyBar, { pending }),
        h('div', { className: busy ? 'cgp-busy' : '' },
          h(Notice, { notice, busy, onFix: actions.applyFix }),
          h(AiEdit, {
            diagrams: flattenDiagrams(tree),
            settings,
            actions,
            busy
          })
        )
      )
    ),

    // ---- Activity ----
    h(Fill, {
      slot: 'bottom-panel', id: ACTIVITY_ID, label: TAB_LABELS.activity, layout, priority: 20
    },
      h(Activity, {
        entries: activity,
        consoleEnabled,
        busy,
        onRefresh: () => loadActivity(),
        onClear: actions.clearActivity,
        onRun: actions.runCommand
      })
    ),

    // ---- Settings ----
    //
    // Last, and deliberately quiet: it is configured once, not operated.
    h(Fill, {
      slot: 'bottom-panel', id: SETTINGS_ID, label: TAB_LABELS.settings, layout, priority: 10
    },
      h(Settings, {
        settings, projectSetup, autoPull: autoPullState, blockedReason, actions, busy
      })
    )
  );
}

registerClientExtension(GitPlugin);

// The one contribution that lives inside the diagram editor rather than the
// bottom panel: hover a task, see how it is configured. Registered as a
// bpmn-js module so it has the editor's eventBus and overlays.
registerBpmnJSPlugin(TaskDetailsModule);
registerBpmnJSPlugin(CatalogInsertModule);
