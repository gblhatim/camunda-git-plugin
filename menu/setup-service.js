/**
 * Getting from "a folder of diagrams" to "a project the team shares".
 *
 * Everything else in this plugin assumes a working repository: a folder, a
 * git directory, an identity to attribute commits to, at least one commit,
 * and usually a server. Until all of that exists, every panel reports an
 * error that is technically accurate and completely unactionable - "not a
 * git repository", "ambiguous argument 'HEAD'" - to someone whose actual
 * question is "how do I start".
 *
 * So setup is a phase with its own state, not an error condition. It is an
 * ordered checklist: each step knows whether it is done, why it is blocked
 * if it is, and what single action completes it. The panel walks down it.
 *
 * Two rules, the same ones the routines follow:
 *
 *  1. Nothing here is destructive. No step deletes, resets, or overwrites.
 *     The riskiest thing it does is create a commit.
 *  2. Every step is skippable or reversible by ordinary means. A project
 *     with no server is a legitimate end state, not an incomplete one.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const configStore = require('./config-store');
const gitService = require('./git-service');
const branchService = require('./branch-service');
const commandLog = require('./command-log');
const naming = require('./naming');

// Diagrams the plugin knows how to show, used to tell an empty folder from
// one that already has work in it.
const DIAGRAM = /\.(bpmn|dmn|form)$/i;

/**
 * A git instance for a folder that may not be a repository yet, so it
 * cannot go through gitService (which throws when nothing is configured).
 */
function gitAt(dir) {
  return commandLog.instrument(simpleGit(dir));
}

function isRepository(dir) {
  if (!dir) {
    return false;
  }

  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch (err) {
    return false;
  }
}

function folderExists(dir) {
  try {
    return !!dir && fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Diagrams sitting in the folder, tracked or not. Answers "is there
 * anything here worth saving" before there is an index to ask.
 */
function countDiagrams(dir) {
  let found = 0;

  const walk = (current, depth) => {
    if (depth > 3 || found > 200) {
      return;
    }

    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;

      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), depth + 1);
      } else if (DIAGRAM.test(entry.name)) {
        found++;
      }
    }
  };

  walk(dir, 0);

  return found;
}

async function readIdentity(dir) {
  try {
    const raw = await gitAt(dir).raw([ 'config', '--list' ]);

    let name = null;
    let email = null;

    raw.split('\n').forEach(line => {
      const at = line.indexOf('=');
      if (at < 0) return;

      const key = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();

      if (key === 'user.name') name = value || null;
      if (key === 'user.email') email = value || null;
    });

    return { name, email };
  } catch (err) {
    return { name: null, email: null };
  }
}

/**
 * The checklist, in the order it has to be done.
 *
 * Every step reports `done`, and the first one that is not done is the only
 * one the panel offers - a checklist that lets you do step 4 before step 2
 * is just an error message with more clicks.
 */
async function inspect() {
  const config = configStore.readConfig();
  const dir = config.repoPath || '';

  const steps = [];

  const hasFolder = folderExists(dir);

  steps.push({
    id: 'folder',
    title: 'Choose where your diagrams live',
    done: hasFolder,
    detail: hasFolder
      ? dir
      : 'Pick the folder your BPMN files are in, or get a copy of the ' +
        'team\'s project.',
    action: 'pick-folder'
  });

  const repo = hasFolder && isRepository(dir);

  steps.push({
    id: 'repository',
    title: 'Start keeping track of changes',
    done: repo,
    blocked: !hasFolder,
    detail: repo
      ? 'This folder keeps a history of every change.'
      : 'Right now changes to these diagrams are not recorded anywhere. ' +
        'This adds that, and changes nothing about the files themselves.',
    action: 'init'
  });

  const identity = repo ? await readIdentity(dir) : { name: null, email: null };
  const hasIdentity = !!(identity.name && identity.email);

  steps.push({
    id: 'identity',
    title: 'Say who you are',
    done: hasIdentity,
    blocked: !repo,
    detail: hasIdentity
      ? `${identity.name} <${identity.email}>`
      : 'Every save point records who made it. Without this, yours are ' +
        'attributed to whatever the computer guesses.',
    action: 'identity',
    value: identity
  });

  const head = repo ? gitService.readHeadSha() : null;
  const diagrams = hasFolder ? countDiagrams(dir) : 0;

  steps.push({
    id: 'first-save',
    title: 'Create the first save point',
    done: !!head,
    blocked: !repo || !hasIdentity,
    detail: head
      ? 'There is a history to build on.'
      : diagrams
        ? `Records the ${diagrams} diagram${diagrams === 1 ? '' : 's'} already ` +
          'in this folder as the starting point.'
        : 'This folder has no diagrams yet. You can do this now or after ' +
          'you make one.',
    action: 'first-save',
    diagrams
  });

  let remote = null;

  if (repo) {
    try {
      remote = await gitService.getRemoteUrl('origin');
    } catch (err) {
      remote = null;
    }
  }

  steps.push({
    id: 'server',
    title: 'Connect the team server',
    done: !!remote,
    blocked: !repo,
    optional: true,
    detail: remote ||
      'Without this the project stays on this computer only - which is ' +
      'fine if you work alone.',
    action: 'connect'
  });

  const shared = hasFolder ? configStore.readShared(dir) : {};
  const configured = !!shared.baseBranch;

  steps.push({
    id: 'project',
    title: 'Agree how the team works',
    done: configured,
    blocked: !repo || !head,
    optional: true,
    detail: configured
      ? `Everyday work on "${shared.baseBranch}".`
      : 'Writes down which branches the team uses, so everyone\'s plugin ' +
        'agrees. Until then the plugin works it out from branch names.',
    action: 'project-setup'
  });

  const required = steps.filter(s => !s.optional);

  return {
    steps,
    complete: required.every(s => s.done),
    ready: !!head,               // enough to actually use the panel
    repoPath: dir,
    next: (steps.find(s => !s.done && !s.blocked && !s.optional) ||
      steps.find(s => !s.done && !s.blocked) || null)
  };
}

// ------------------------------------------------------------------ steps

/**
 * `git init`. Creates a history for a folder that already has files in it;
 * nothing is moved, renamed or deleted.
 */
async function initRepository() {
  const dir = configStore.readConfig().repoPath;

  if (!folderExists(dir)) {
    throw new Error('Choose a folder first.');
  }

  if (isRepository(dir)) {
    return { already: true, summary: 'This folder is already being tracked.' };
  }

  // `-b main` rather than git's compiled-in default, so a fresh project does
  // not start on `master` and then disagree with the team's settings.
  await gitAt(dir).init([ '-b', 'main' ]);

  return {
    ok: true,
    summary: 'This folder now keeps a history of every change.'
  };
}

async function setIdentity({ name, email }) {
  const dir = configStore.readConfig().repoPath;

  if (!isRepository(dir)) {
    throw new Error('Set the folder up for tracking changes first.');
  }

  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim();

  if (!cleanName) {
    throw new Error('Please enter your name.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please enter a valid email address.');
  }

  const git = gitAt(dir);

  // Written to this project only. Setting it globally would change the
  // attribution of every other repository on the machine, which is not
  // something a setup wizard should do behind someone's back.
  await git.raw([ 'config', 'user.name', cleanName ]);
  await git.raw([ 'config', 'user.email', cleanEmail ]);

  return { ok: true, summary: `Save points here will be recorded as ${cleanName}.` };
}

/**
 * The first commit. Everything downstream - history, diffs, branches,
 * ahead/behind - needs one to exist.
 */
async function createFirstSavePoint(message) {
  const dir = configStore.readConfig().repoPath;

  if (!isRepository(dir)) {
    throw new Error('Set the folder up for tracking changes first.');
  }

  if (gitService.readHeadSha()) {
    return { already: true, summary: 'This project already has a history.' };
  }

  const git = gitAt(dir);
  const text = String(message || '').trim() || 'Starting point';

  await git.add([ '-A' ]);

  const status = await git.status();

  if (!status.staged.length) {
    // An empty first commit is still the right answer: it gives the project
    // a history to branch from, which is what the rest of the plugin needs.
    await git.raw([ 'commit', '--allow-empty', '-m', text ]);

    return {
      ok: true,
      empty: true,
      summary: 'Created a starting point. Save your diagrams as you make them.'
    };
  }

  await git.commit(text);

  return {
    ok: true,
    files: status.staged.length,
    summary: `Saved ${status.staged.length} file(s) as the starting point.`
  };
}

/**
 * Make every fetch against this remote drop the tracking refs for branches
 * that no longer exist on the server.
 *
 * Git does not do this by default, and the consequences are all confusing
 * rather than dangerous: a branch someone deleted keeps appearing in the
 * workstream list, switching to it recreates it, and "get updates" fails
 * with "couldn't find remote ref". Set once here rather than remembered as
 * a flag at each of the call sites that fetch.
 *
 * Written to this project only - a setup step has no business changing how
 * fetch behaves in every other repository on the machine.
 */
async function enablePruneOnFetch(git) {
  try {
    await git.raw([ 'config', 'remote.origin.prune', 'true' ]);
  } catch (err) {
    // Not worth failing the connection over - the fetches that matter pass
    // --prune explicitly anyway.
  }
}

/**
 * Point the project at a server. Only adds the remote - nothing is sent
 * until the user asks, because a first push can be a surprisingly large
 * and public act.
 */
async function connectRemote(url) {
  const dir = configStore.readConfig().repoPath;

  if (!isRepository(dir)) {
    throw new Error('Set the folder up for tracking changes first.');
  }

  const clean = String(url || '').trim();

  if (!clean) {
    throw new Error('Paste the address of the project on the server.');
  }

  // Deliberately permissive. The reachability check below is the real
  // validation, and a git remote is not always a URL: a network share
  // (\\fileserver\projects\repo.git) or a local path is a perfectly
  // ordinary "team server" somewhere without GitHub, and rejecting those
  // on shape would be wrong about a setup the plugin otherwise supports.
  // This only catches input that cannot be an address at all.
  if (/\s/.test(clean) && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(clean)) {
    throw new Error(
      'That does not look like a project address. It should be a link ' +
      'starting with https:// or git@, or a folder on the network.'
    );
  }

  const git = gitAt(dir);
  const existing = await git.getRemotes(true);

  if (existing.some(r => r.name === 'origin')) {
    await git.raw([ 'remote', 'set-url', 'origin', clean ]);
  } else {
    await git.addRemote('origin', clean);
  }

  await enablePruneOnFetch(git);

  // Prove it is reachable before reporting success - a typo here otherwise
  // surfaces much later, as a failed push, looking like a different problem.
  try {
    await git.raw([ 'ls-remote', '--heads', 'origin' ]);
  } catch (err) {
    throw new Error(
      'Added, but the server did not answer. Check the address and your ' +
      'access, then try again. Nothing has been sent.'
    );
  }

  return { ok: true, summary: 'Connected. You can now send and get updates.' };
}

/**
 * Copy the team's existing project onto this computer.
 *
 * The other way in, and for an analyst joining a team it is the normal one:
 * somebody sends a link. Clones into a *new* folder inside the chosen
 * parent, and refuses to touch one that already has anything in it.
 */
async function cloneProject({ url, parentDir, folderName }) {
  const clean = String(url || '').trim();

  if (!clean) {
    throw new Error('Paste the address of the team\'s project.');
  }

  if (!folderExists(parentDir)) {
    throw new Error('Choose where to put the copy first.');
  }

  const guessed = String(folderName || '').trim() ||
    (clean.replace(/\.git$/, '').split(/[/:]/).pop() || 'project');

  const target = path.join(parentDir, guessed);

  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error(
      `"${guessed}" already exists here and is not empty. Choose a different ` +
      'place, or pick that folder directly if it is already the project.'
    );
  }

  await gitAt(parentDir).clone(clean, target);

  // A clone sets up `origin` itself, so it never passes through
  // connectRemote() - it needs the same prune setting applied here.
  await enablePruneOnFetch(gitAt(target));

  configStore.update({ repoPath: target });

  // A clone whose remote HEAD points at a branch that does not exist checks
  // out nothing, and the user is left looking at an empty folder with no
  // hint why. Servers set up by hand do this more often than hosted ones.
  // Land on a real branch instead.
  const checkedOut = await ensureWorkingTree(target);

  return {
    ok: true,
    repoPath: target,
    branch: checkedOut,
    summary: `Copied the team's project into "${guessed}".`
  };
}

/**
 * Make sure a freshly cloned repository has something checked out.
 * Returns the branch it ended up on, or null if the project is genuinely
 * empty (which is a valid thing to clone).
 */
async function ensureWorkingTree(dir) {
  const git = gitAt(dir);

  try {
    const current = await git.raw([ 'rev-parse', '--abbrev-ref', 'HEAD' ]);

    if (current.trim() && current.trim() !== 'HEAD') {
      const head = await git.raw([ 'rev-parse', '--verify', '--quiet', 'HEAD' ])
        .catch(() => '');

      if (head.trim()) {
        return current.trim();
      }
    }
  } catch (err) {
    // Unborn HEAD - fall through and look for a branch to use.
  }

  const remoteHeads = await git.raw([
    'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'
  ]).catch(() => '');

  // `origin` on its own is how `%(refname:short)` renders
  // `refs/remotes/origin/HEAD`, so it has to be excluded alongside the
  // obvious spelling - otherwise a clone with no main/master/develop falls
  // through to `checkout -B origin origin/origin`, which cannot work.
  const candidates = remoteHeads.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(ref => !ref.endsWith('/HEAD') && ref !== 'origin')
    .map(ref => ref.replace(/^origin\//, ''));

  if (!candidates.length) {
    return null;
  }

  // Prefer the names a shared branch usually has, then anything.
  const preferred = [ 'main', 'master', 'develop' ].find(n => candidates.includes(n)) ||
    candidates[0];

  await git.checkout([ '-B', preferred, `origin/${preferred}` ]);

  return preferred;
}

/**
 * Create a branch the team's settings expect but this copy does not have -
 * normally `develop` on a project moving to the Gitflow layout.
 */
async function createBranch(name) {
  const clean = naming.slugify(name);
  const known = await branchService.listKnownBranchNames();

  if (known.has(clean)) {
    return { already: true, summary: `"${clean}" already exists.` };
  }

  if (!gitService.readHeadSha()) {
    throw new Error('Create the first save point before adding branches.');
  }

  await gitService.getGit().raw([ 'branch', clean ]);

  return { ok: true, summary: `Created "${clean}".` };
}

module.exports = {
  inspect,
  initRepository,
  setIdentity,
  createFirstSavePoint,
  connectRemote,
  cloneProject,
  createBranch,
  enablePruneOnFetch,
  isRepository,
  countDiagrams
};
