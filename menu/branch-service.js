/**
 * Branches, presented as "workstreams".
 *
 * The vocabulary shift is deliberate. A branch is a developer concept tied
 * to a commit DAG; a workstream is "the thing I am currently working on",
 * which is what a process analyst actually has in their head. Same git
 * objects underneath, no graph, no merge-base talk.
 *
 * The other deliberate choice: every switch saves first. "cannot switch
 * branch, you have local changes" is one of the most common ways a
 * non-technical user gets stuck, and it is entirely preventable rather
 * than something to explain afterwards.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gitService = require('./git-service');
const configStore = require('./config-store');
const naming = require('./naming');
const settingsService = require('./settings-service');
const { isMergeInProgress } = require('./conflict-service');

// Fallback only, for a repository with no committed team settings. The
// order matters: `develop` is last because a repo that has both `main` and
// `develop` is almost certainly using Gitflow, and guessing `develop` as
// the single trunk there would be worse than guessing `main`.
const MAIN_CANDIDATES = [ 'main', 'master', 'develop' ];

// Gitflow's own defaults, used when the model is set but the branch names
// are not.
const GITFLOW_DEFAULTS = { base: 'develop', release: 'main' };

/**
 * Naming lives in naming.js - branch names carry a type, a ticket and a
 * title, and all three are recovered by parsing rather than stored.
 *
 * These two stay here as thin pass-throughs because every caller in the
 * plugin already reaches for them on this module.
 */
function humanize(branchName) {
  return naming.humanize(branchName, configStore.readConfig());
}

function slugify(displayName) {
  return naming.slugify(displayName);
}

/**
 * Guess the shared branch, for a repository that has not been configured.
 */
async function guessMainBranch() {
  const git = gitService.getGit();
  const branches = await git.branchLocal();

  const local = MAIN_CANDIDATES.find(c => branches.all.includes(c));

  if (local) {
    return local;
  }

  // Fall back to whatever the remote considers its default - but only ask
  // when there is one to ask about. `symbolic-ref` exits non-zero on a repo
  // with no remote, which is an ordinary state that should not surface in
  // Activity as a failed command.
  if (!fs.existsSync(path.join(gitService.gitDir(), 'refs', 'remotes', 'origin', 'HEAD'))) {
    return branches.current;
  }

  try {
    const remote = await git.raw([ 'symbolic-ref', 'refs/remotes/origin/HEAD' ]);
    return remote.trim().replace('refs/remotes/origin/', '');
  } catch (err) {
    return branches.current;
  }
}

/**
 * The two long-lived branches, from the team's committed settings.
 *
 * `base` is where work starts and returns to; `release` is what has shipped.
 * Under trunk-based development they are the same branch, which keeps every
 * caller free of `if (gitflow)`.
 *
 * A configured branch that does not exist locally *or* on the server is
 * reported rather than thrown: a fresh clone that has not fetched yet, or a
 * typo in the committed file, must not leave the panel unusable. The caller
 * surfaces `warning`, so a mismatch is visible instead of silently becoming
 * a guess - the whole reason this moved out of a candidate list.
 */
async function resolveBranches() {
  const config = configStore.readConfig();
  const gitflow = config.branchModel === 'gitflow';

  const configured = {
    base: config.baseBranch || (gitflow ? GITFLOW_DEFAULTS.base : null),
    release: config.releaseBranch || (gitflow ? GITFLOW_DEFAULTS.release : null)
  };

  const model = gitflow ? 'gitflow' : 'trunk';

  if (!configured.base) {
    const guessed = await guessMainBranch();

    return {
      model,
      base: guessed,
      release: configured.release || guessed,
      configured: false,
      warning: null
    };
  }

  const known = await listKnownBranchNames();
  const missing = [ configured.base, configured.release ]
    .filter(Boolean)
    .filter(name => !known.has(name));

  const guessed = missing.length ? await guessMainBranch() : null;

  return {
    model,
    base: known.has(configured.base) ? configured.base : guessed,
    release: known.has(configured.release) ? configured.release : (guessed || configured.base),
    configured: true,
    warning: missing.length
      ? `This project is set up to use ${missing.join(' and ')}, but ` +
        `${missing.length === 1 ? 'that branch does not' : 'those branches do not'} ` +
        'exist yet. Get updates from the team, or ask whoever set the project up.'
      : null
  };
}

/**
 * The remote's HEAD pointer, which is not a branch and must never be listed
 * as one.
 *
 * It has two spellings and only one of them is obvious. `%(refname:short)`
 * renders `refs/remotes/origin/HEAD` as bare **`origin`** - the remote's own
 * name, with nothing after it - so a filter that only looks for a `/HEAD`
 * suffix misses it entirely. It then survives the `origin/` prefix strip
 * unchanged (it has no prefix to strip) and arrives in the workstream list
 * as a workstream called "origin", in every repository that was cloned
 * rather than created locally. Switching to it tries
 * `checkout -b origin origin/origin`, which cannot work.
 */
function isRemoteHead(ref) {
  return ref.endsWith('/HEAD') || ref === 'origin';
}

/**
 * Every branch name this clone knows about, local or on the server, with
 * the `origin/` prefix stripped - so a branch that exists only on the
 * server still counts as existing.
 */
async function listKnownBranchNames() {
  const git = gitService.getGit();

  const raw = await git.raw([
    'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'
  ]);

  const names = new Set();

  raw.split('\n').filter(Boolean).forEach(ref => {
    if (isRemoteHead(ref)) return;

    names.add(ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref);
  });

  return names;
}

/**
 * Just the branches the server has, by the names they go by locally.
 *
 * Separate from listKnownBranchNames(), which unions local and remote: this
 * is used to measure what changed on the *server* across a fetch, so mixing
 * in local-only branches would report them as having appeared or vanished
 * when nothing on the server moved.
 */
async function listServerBranchNames() {
  const git = gitService.getGit();

  const raw = await git.raw([
    'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'
  ]);

  const names = new Set();

  raw.split('\n').filter(Boolean).forEach(ref => {
    if (isRemoteHead(ref)) return;

    names.add(ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref);
  });

  return names;
}

/**
 * The branch work starts from and returns to.
 *
 * Kept as the old name because most callers only ever wanted this one; the
 * places that must distinguish base from release call resolveBranches().
 */
async function findMainBranch() {
  return (await resolveBranches()).base;
}

/**
 * Neither long-lived branch is a workstream, and neither may be deleted.
 */
async function protectedBranches() {
  const { base, release } = await resolveBranches();

  return [ base, release ].filter(Boolean);
}

/**
 * Every workstream, local and on the server, with enough context to answer
 * "is anyone else on this?" without showing a graph.
 */
async function listWorkstreams() {
  const git = gitService.getGit();
  const { status } = await gitService.getStatus();
  const current = status.current;
  const branches = await resolveBranches();
  const main = branches.base;
  const config = configStore.readConfig();

  // One call for everything; `for-each-ref` avoids a per-branch round trip.
  const raw = await git.raw([
    'for-each-ref',
    '--format=%(refname:short)%09%(committerdate:iso8601)%09%(authorname)%09%(subject)',
    'refs/heads',
    'refs/remotes/origin'
  ]);

  const seen = new Set();
  const streams = [];

  raw.split('\n').filter(Boolean).forEach(line => {
    const [ ref, date, author, subject ] = line.split('\t');

    if (!ref || isRemoteHead(ref)) {
      return;
    }

    const isRemote = ref.startsWith('origin/');
    const name = isRemote ? ref.slice('origin/'.length) : ref;

    // A branch that exists locally and remotely is one workstream, not two.
    //
    // `refs/heads` is listed first, so the local copy is the one that gets
    // pushed and the remote one only ever updates it. Both flags have to
    // move: setting `onServer` while leaving `localOnly` true left every
    // published branch claiming both, and the panel headline reads
    // `localOnly` - so it told people their work was "not on the server
    // yet" immediately after they had sent it.
    if (seen.has(name)) {
      const existing = streams.find(s => s.name === name);
      if (existing && isRemote) {
        existing.onServer = true;
        existing.localOnly = false;
      }
      return;
    }

    seen.add(name);

    const parsed = naming.parse(name, config);

    streams.push({
      name,
      title: humanize(name),
      type: parsed.type,
      ticket: parsed.ticket,
      ticketUrl: naming.ticketUrl(parsed.ticket, config),
      isCurrent: name === current,

      // `isMain` is the branch work starts from - what the panel labels
      // "the shared version". Under Gitflow the released branch is a
      // separate thing again, and is not somewhere anyone works.
      isMain: name === branches.base,
      isRelease: name === branches.release && branches.release !== branches.base,
      onServer: isRemote,
      localOnly: !isRemote,
      lastChange: date || null,
      lastAuthor: author || '',
      lastMessage: subject || ''
    });
  });

  // Current first, then the shared branch, then most recently touched.
  streams.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return String(b.lastChange).localeCompare(String(a.lastChange));
  });

  return {
    current,
    main,
    model: branches.model,
    release: branches.release,
    configured: branches.configured,
    warning: branches.warning,

    // The create form is built from this rather than from a copy of the
    // rules in the renderer, so the ticket requirement cannot drift
    // between what the UI enforces and what the branch name gets.
    naming: {
      projectKey: naming.projectKey(config),
      types: naming.TYPE_IDS.map(id => {
        const type = naming.TYPES[id];

        return {
          id,
          label: type.label,
          hint: type.hint,
          ticketRequired: type.ticketRequired,
          startsFrom: type.startsFrom === 'release' ? branches.release : branches.base
        };
      })
    },

    streams
  };
}

/**
 * Save whatever is in progress, so a switch or a new workstream can never
 * be blocked by uncommitted changes.
 *
 * Returns a description of what it did, so the UI can tell the user their
 * work was tucked away rather than silently moving it.
 */
async function saveWorkInProgress() {
  const { status } = await gitService.getStatus();

  if (!status.files.length) {
    return null;
  }

  await gitService.stageAll();
  await gitService.commitStaged('Work in progress');

  return {
    saved: status.files.length,
    branch: status.current
  };
}

async function switchTo(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Which workstream should I switch to?');
  }

  const { streams, current } = await listWorkstreams();

  if (name === current) {
    return { switched: false, to: name, autoSaved: null };
  }

  const target = streams.find(s => s.name === name);

  if (!target) {
    throw new Error(`There is no workstream called "${name}".`);
  }

  const autoSaved = await saveWorkInProgress();

  const git = gitService.getGit();

  if (target.localOnly || (await git.branchLocal()).all.includes(name)) {
    await git.checkout(name);
  } else {
    // Exists only on the server: create a local copy that tracks it.
    await git.checkout([ '-b', name, `origin/${name}` ]);
  }

  return { switched: true, to: name, title: humanize(name), autoSaved };
}

/**
 * Start a new workstream.
 *
 * Branching from the *server's* copy rather than the local one matters:
 * otherwise someone whose shared branch is a week stale starts a week
 * behind and discovers it only at merge time.
 *
 * Which branch that is depends on the kind of work. An urgent fix has to
 * grow from what is actually released, not from whatever is queued up for
 * the next one - branching a hotfix off the integration branch is how
 * unreleased work reaches production by accident. Under a trunk model the
 * two are the same branch and this costs nothing.
 *
 * Accepts either the new shape ({ type, ticket, title }) or a bare display
 * name, which keeps the untyped path working for a project that has not
 * been set up for the team yet.
 */
async function createWorkstream(input) {
  const config = configStore.readConfig();
  const request = typeof input === 'string' ? { title: input } : (input || {});

  const built = request.type
    ? naming.buildBranchName(request, config)
    : { name: naming.slugify(request.title), type: null, ticket: null, startsFrom: 'base' };

  const git = gitService.getGit();
  const { streams } = await listWorkstreams();

  if (streams.some(s => s.name === built.name)) {
    throw new Error(`A workstream called "${humanize(built.name)}" already exists.`);
  }

  const autoSaved = await saveWorkInProgress();
  const branches = await resolveBranches();
  const source = built.startsFrom === 'release' ? branches.release : branches.base;

  let startedFrom = source;
  const hasRemote = !!(await gitService.getRemoteUrl('origin'));

  if (hasRemote) {
    try {
      await git.fetch([ 'origin', source ]);
      startedFrom = `origin/${source}`;
    } catch (err) {
      // Offline: starting from the local shared version is still valid.
      startedFrom = source;
    }
  }

  // `--no-track` matters more than it looks.
  //
  // Branching from `origin/develop` makes git, by default
  // (`branch.autoSetupMerge`), set the new branch's upstream to
  // origin/develop - so a brand new workstream reports itself as tracking
  // the shared branch. Three things then go wrong: a plain push fails with
  // "the upstream branch of your current branch does not match", the
  // panel's ahead/behind counts are measured against the wrong branch, and
  // with `push.default = upstream` a push would write the workstream
  // straight onto the shared branch, bypassing review entirely.
  //
  // A workstream has no upstream until it is first sent; `publishCurrentBranch()`
  // sets it then, to a remote branch of the same name.
  await git.checkout([ '-b', built.name, '--no-track', startedFrom ]);

  return {
    created: true,
    name: built.name,
    title: humanize(built.name),
    type: built.type,
    ticket: built.ticket,
    ticketUrl: naming.ticketUrl(built.ticket, config),
    startedFrom,
    autoSaved
  };
}

/**
 * The remote branch a local branch is tracking, without the remote prefix.
 * `origin/feature/x` -> `feature/x`, using the real remote names rather
 * than assuming the first path segment is one.
 */
async function upstreamBranchName(tracking) {
  if (!tracking) {
    return null;
  }

  const git = gitService.getGit();
  const remotes = await git.getRemotes(false);

  const remote = remotes
    .map(r => r.name)
    .sort((a, b) => b.length - a.length)
    .find(name => tracking.startsWith(`${name}/`));

  return remote ? tracking.slice(remote.length + 1) : tracking;
}

/**
 * Send the current branch to the server, choosing a refspec that cannot
 * write to a branch other than the one you are on.
 *
 * A plain `git push` is only safe when the upstream has the same name as
 * the local branch. When it does not, git either refuses ("the upstream
 * branch of your current branch does not match the name of your current
 * branch") or, under `push.default = upstream`, quietly pushes your work
 * onto that differently-named branch. The second outcome is the dangerous
 * one: it is how a workstream lands on the shared branch with nobody
 * reviewing it.
 *
 * So a mismatch is never resolved by pushing to whatever is tracked:
 *
 *   - upstream is a long-lived branch -> the tracking is wrong, almost
 *     certainly inherited from the branch this was started from. Publish
 *     under this branch's own name and repoint the upstream at it.
 *   - upstream is some other name -> somebody set that up deliberately
 *     (a rename, a differently-named remote branch). Push to it explicitly,
 *     which is what they asked for and what git itself suggests first.
 *
 * Either way the refspec is explicit, so the destination is never left to
 * `push.default`.
 */
/**
 * Detached HEAD, in the terms it actually matters in.
 *
 * simple-git reports `current` as the literal string "HEAD" here, which is
 * not a branch name and must never be treated as one: pushing it would
 * create a branch called `HEAD` on the server, and any save point made in
 * this state is unreachable the moment you switch away. Both push and pull
 * refuse rather than improvise.
 */
function assertOnBranch(status, verb) {
  if (!status.detached && status.current && status.current !== 'HEAD') {
    return status.current;
  }

  throw new Error(
    'You are looking at an old version of the project rather than working ' +
    `on a workstream, so there is nothing to ${verb}. Anything you save here ` +
    'would be hard to find again. Use "Put me back on a workstream" first - ' +
    'nothing is lost.'
  );
}

async function publishCurrentBranch() {
  const git = gitService.getGit();
  const { status } = await gitService.getStatus();
  const current = assertOnBranch(status, 'send');

  const upstream = status.tracking;
  const upstreamName = await upstreamBranchName(upstream);

  // Never sent before: publish under this name and start tracking it.
  if (!upstream) {
    await git.push([ '--set-upstream', 'origin', `${current}:${current}` ]);
    return { pushed: current, setUpstream: true, repaired: false };
  }

  if (upstreamName === current) {
    await git.push([ 'origin', `${current}:${current}` ]);
    return { pushed: current, setUpstream: false, repaired: false };
  }

  const protectedNames = await protectedBranches();

  if (protectedNames.includes(upstreamName)) {
    await git.push([ '--set-upstream', 'origin', `${current}:${current}` ]);

    return {
      pushed: current,
      setUpstream: true,
      repaired: true,
      wasTracking: upstream
    };
  }

  await git.push([ 'origin', `${current}:${upstreamName}` ]);

  return { pushed: upstreamName, setUpstream: false, repaired: false, renamed: true };
}

/**
 * Does the server have a branch of this name?
 *
 * Read from the remote-tracking refs rather than by asking the server, so
 * it costs nothing.
 *
 * Callers that need it to be current must fetch **with `--prune`** first. A
 * bare fetch leaves the ref for a branch someone deleted on the server in
 * place, and this then reports it as existing - which is worse than a stale
 * "no", because the caller goes on to pull from something that is not there.
 */
async function remoteBranchExists(name) {
  const git = gitService.getGit();

  const raw = await git.raw([
    'for-each-ref', '--format=%(refname:short)', `refs/remotes/origin/${name}`
  ]);

  return !!raw.trim();
}

/**
 * The ref to *measure* a branch against: the server's copy when this clone
 * has one, the local branch when it does not.
 *
 * The distinction runs through everything here and is easy to get wrong in
 * the same direction every time. Two different questions get asked about a
 * branch name:
 *
 *   measuring - "how far behind is my work?", "has this been merged?",
 *               "what is queued for release?" These are questions about
 *               what *the team* has, and answering them from a local
 *               branch answers a question about this laptop instead. A
 *               developer whose `develop` is a week stale gets told a
 *               merged branch is unmerged, and a workstream that is behind
 *               is up to date.
 *
 *   acting    - merging, checking out, branching. These must use the local
 *               branch, because that is what a commit can be made on and
 *               what a push sends.
 *
 * So: measure with this, act with the plain name. Every counting and
 * containment check in the plugin goes through here; nothing that changes
 * the repository does.
 */
async function serverTip(name) {
  if (!name) {
    return null;
  }

  try {
    return (await remoteBranchExists(name)) ? `origin/${name}` : name;
  } catch (err) {
    return name;
  }
}

/**
 * Pull, treating a conflict as an outcome rather than a failure.
 *
 * `git pull` exits non-zero when the merge stops on a conflict, so
 * simple-git throws - and the bridge's error translator then reported
 * "Something went wrong" to someone whose diagrams are perfectly fine and
 * who simply needs to choose a version. It is the single most likely moment
 * for this plugin's audience to need reassurance, and it was the moment it
 * was least reassuring.
 *
 * A conflict is a normal, recoverable state that the resolver takes over.
 * Only a pull that failed *without* leaving a merge open is a real error.
 */
async function pullFrom(git, branchName) {
  try {
    await git.raw([ 'pull', '--no-rebase', 'origin', branchName ]);
    return { conflicted: false };
  } catch (err) {
    if (!isMergeInProgress()) {
      throw err;
    }

    return {
      conflicted: true,
      summary:
        'You and the team both changed the same diagrams. Nothing is lost - ' +
        'choose which version to keep below, then finish up.'
    };
  }
}

/**
 * Get updates for the branch you are on.
 *
 * The mirror image of publishCurrentBranch(), and it exists for the same
 * reason: a plain `git pull` needs an upstream, and there are three
 * ordinary ways not to have a usable one.
 *
 *   - never had one. `git push origin main` without `-u` leaves the branch
 *     untracked, and then "Get updates" fails with "there is no tracking
 *     information for the current branch" - a message that tells a process
 *     analyst nothing they can act on.
 *   - inherited the wrong one from the branch it was started from (see
 *     publishCurrentBranch). Pulling that would merge the *shared branch*
 *     into a workstream, which is not what "get updates" means to anyone.
 *   - the workstream is genuinely not on the server yet, in which case
 *     there is nothing to get and that is a normal answer, not a failure.
 *
 * Where a matching branch does exist on the server, this pulls from it and
 * records it as the upstream, so the problem does not recur.
 */
async function pullCurrentBranch() {
  const git = gitService.getGit();
  const { status } = await gitService.getStatus();
  const current = assertOnBranch(status, 'get');

  if (!(await gitService.getRemoteUrl('origin'))) {
    throw new Error(
      'This project has no team server set up, so there are no updates to get.'
    );
  }

  // Find out what the server actually has before deciding anything, and
  // make sure that answer is current in both directions.
  //
  // `--prune` is not optional. A plain fetch only *adds* remote-tracking
  // refs; it never removes the ones whose branch was deleted on the server.
  // Without it `remoteBranchExists()` answers yes for a branch that is gone
  // and the pull fails with "couldn't find remote ref", and the workstream
  // list keeps offering branches nobody can switch to.
  //
  // This runs before the upstream check rather than only in the repair path
  // below, because the branch that is *correctly* tracked is the common
  // case - and a repository that was set up before `remote.origin.prune`
  // was written would otherwise never prune at all. "Get updates" is a
  // network operation either way, so the extra round trip costs nothing
  // that was not already being spent.
  await git.fetch([ 'origin', '--prune' ]);

  const upstreamName = await upstreamBranchName(status.tracking);

  if (upstreamName === current) {
    return Object.assign({ pulled: current, linked: false }, await pullFrom(git, current));
  }

  // Either no upstream or the wrong one.
  if (await remoteBranchExists(current)) {
    const outcome = await pullFrom(git, current);

    await git.raw([ 'branch', `--set-upstream-to=origin/${current}`, current ]);

    return Object.assign(
      { pulled: current, linked: true, wasTracking: status.tracking || null },
      outcome
    );
  }

  // Nothing on the server under this name. Saying so plainly beats git's
  // "specify which branch you want to merge with", which invites someone to
  // pick the shared branch and quietly merge it in.
  return {
    pulled: null,
    linked: false,
    nothingToGet: true,
    summary:
      `"${humanize(current)}" is not on the team server yet, so there is ` +
      'nothing to get. Send it first and updates will work from then on.'
  };
}

/**
 * Get back onto a workstream from a detached HEAD, without losing anything.
 *
 * Detached HEAD is the one state where git will silently discard committed
 * work: commits made here belong to no branch, and once you check one out
 * they are unreferenced and eventually collected. A non-technical user has
 * no way to know that, and the usual advice ("note the sha down first") is
 * not advice they can act on.
 *
 * So this is careful about the order:
 *
 *   1. commit anything uncommitted, so it is at least an object in the
 *      repository rather than only in the working tree;
 *   2. work out whether this commit is already on a branch;
 *   3. if it is, just go there - nothing needed a home;
 *   4. if it is not, give it a branch *before* moving anywhere.
 *
 * Step 4 is the whole point. It is also why this never uses `checkout -f`
 * or discards: there is no version of this operation that is allowed to
 * throw work away.
 */
async function rescueDetachedHead() {
  const git = gitService.getGit();
  const { status } = await gitService.getStatus();

  if (!status.detached && status.current && status.current !== 'HEAD') {
    return `You are already on "${humanize(status.current)}".`;
  }

  const autoSaved = await saveWorkInProgress();
  const sha = gitService.readHeadSha();

  if (!sha) {
    // No commits at all; just land on the shared branch.
    const { base } = await resolveBranches();
    await git.checkout(base);

    return `Back on "${humanize(base)}".`;
  }

  const contains = await git.raw([ 'branch', '--contains', sha ]);

  const holders = contains.split('\n')
    .map(line => line.replace(/^[*+]?\s*/, '').trim())
    .filter(Boolean)
    .filter(name => !name.startsWith('(') && name !== 'HEAD');

  // Already on a branch, and nothing new was made here: simply go back.
  if (holders.length && !autoSaved) {
    await git.checkout(holders[0]);

    return `Back on "${humanize(holders[0])}". Nothing was lost.`;
  }

  // These commits exist nowhere else. Give them a branch before moving.
  const label = naming.slugify(`recovered work ${sha.slice(0, 7)}`);

  await git.checkout([ '-b', label ]);

  const saved = autoSaved
    ? ` The ${autoSaved.saved} unsaved change(s) were saved into it too.`
    : '';

  return (
    `Your work was not on any workstream, so it has been put on a new one ` +
    `called "${humanize(label)}".${saved} Nothing was lost - rename or ` +
    'finish it like any other workstream.'
  );
}

/**
 * Repair a workstream whose upstream points at a different branch.
 *
 * Offered as a fix alongside the translated error, and safe by
 * construction: it only publishes the current branch under its own name and
 * repoints the upstream marker. Nothing is overwritten, and the branch it
 * was mistakenly tracking is not touched.
 */
async function realignUpstream() {
  const { status } = await gitService.getStatus();
  const current = status.current;
  const upstreamName = await upstreamBranchName(status.tracking);

  if (!current) {
    throw new Error('You are not on a workstream, so there is nothing to line up.');
  }

  if (upstreamName === current) {
    return `"${humanize(current)}" is already lined up with the server.`;
  }

  const result = await publishCurrentBranch();

  return result.repaired || result.setUpstream
    ? `"${humanize(current)}" is now its own workstream on the server, ` +
      'separate from the shared version. Sending works normally from now on.'
    : `Sent "${humanize(current)}" to "${result.pushed}" on the server.`;
}

/**
 * Merge a workstream into the shared version.
 *
 * `--no-ff` is deliberate: it keeps each workstream visible as a unit in
 * the history rather than dissolving it into a line of unrelated commits.
 * When someone asks "what changed in the refund redesign?", that is the
 * difference between one answer and an archaeology exercise.
 *
 * A conflict here is not an error - it is a normal outcome that hands over
 * to the conflict resolver, so it is reported rather than thrown.
 */
async function mergeIntoMain(name) {
  const git = gitService.getGit();
  const main = await findMainBranch();

  if (name === main) {
    throw new Error('This is already the shared version.');
  }

  const autoSaved = await saveWorkInProgress();

  await git.checkout(main);

  const hasRemote = !!(await gitService.getRemoteUrl('origin'));

  if (hasRemote) {
    try {
      await git.raw([ 'pull', '--no-rebase', 'origin', main ]);
    } catch (err) {
      // Offline, or nothing to pull - merging locally is still valid.
    }
  }

  // `git merge` reports a conflict on *stdout* and, through simple-git's
  // raw(), resolves rather than rejecting - so the output has to be
  // inspected. Relying on a thrown error here silently reported success
  // while leaving a half-finished merge behind.
  let output = '';

  try {
    output = await git.raw([ 'merge', '--no-ff', name, '-m', `Merge "${humanize(name)}"` ]);
  } catch (err) {
    output = err.message || '';

    if (!/conflict/i.test(output)) {
      throw err;
    }
  }

  // Belt and braces: the on-disk marker is the authority on whether a
  // merge is still open, whatever the text said.
  const stillMerging = /conflict/i.test(output) || isMergeInProgress();

  if (stillMerging) {
    return { merged: false, needsDecision: true, main, autoSaved };
  }

  return { merged: true, needsDecision: false, main, autoSaved };
}

/**
 * Is `name` already contained in `base` by ancestry - the plain case where
 * the branch was merged without rewriting anything?
 *
 * `git merge-base --is-ancestor` is the obvious command and cannot be used
 * here: it reports its answer *only* through the exit code, writing nothing
 * to stdout or stderr, and simple-git resolves rather than rejecting when a
 * command exits non-zero with empty stderr. Every branch therefore came back
 * as "merged", including ones whose work existed nowhere else - a guardrail
 * that silently answered yes to everything.
 *
 * Comparing the merge base against the tip is the same question asked in a
 * form whose answer arrives on stdout, where it cannot be lost.
 */
async function isAncestorOf(name, base) {
  const git = gitService.getGit();

  try {
    const [ mergeBase, tip ] = await Promise.all([
      git.raw([ 'merge-base', name, base ]),
      git.raw([ 'rev-parse', `${name}^{commit}` ])
    ]);

    return mergeBase.trim() === tip.trim() && !!tip.trim();
  } catch (err) {
    return false;
  }
}

/**
 * Is this branch's work already in `base`, whatever route it took to get
 * there?
 *
 * `git branch -d` answers a narrower question - is the branch tip an
 * ancestor - and that answer is wrong for the way most teams actually
 * merge. A squash merge (GitHub and GitLab's default "Squash and merge")
 * replaces the branch's commits with one new commit, and a rebase merge
 * rewrites them; in both cases every line of the work is on `base` and the
 * tip is an ancestor of nothing. `-d` then refuses with "not fully merged"
 * about a branch that was merged, which under this plugin's *default*
 * review policy is the normal case rather than the exception.
 *
 * `merge-tree --write-tree` answers the question that actually matters:
 * would merging this change anything? If the result is `base`'s own tree,
 * the branch contains nothing that is not already there, and deleting it
 * cannot lose work no matter what git's ancestry check thinks.
 *
 * Needs git 2.38+. Older versions fall back to `null`, meaning "cannot
 * tell" - and the caller then treats it as unmerged, which is the safe
 * direction to be wrong in.
 */
async function isContainedIn(base, name) {
  const git = gitService.getGit();

  try {
    const merged = (await git.raw([ 'merge-tree', '--write-tree', base, name ])).trim().split('\n')[0];
    const baseTree = (await git.raw([ 'rev-parse', `${base}^{tree}` ])).trim();

    return merged === baseTree;
  } catch (err) {
    return null;
  }
}

/**
 * Whether a workstream can be removed, and how much of a decision it is.
 *
 * Split out from the deletion itself so the panel can explain *before*
 * asking. The three outcomes are genuinely different and flattening them
 * into "delete / can't delete" is what makes branch cleanup feel dangerous:
 *
 *   merged     - the tip is on the shared branch. Nothing to think about.
 *   contained  - merged by squash or rebase, so the work is there but the
 *                commits are not. Safe, but git will not do it without -D,
 *                and the reader deserves to know why.
 *   unmerged   - there really is work here that exists nowhere else.
 */
async function planDeleteWorkstream(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Which workstream should I remove?');
  }

  const { base } = await resolveBranches();
  const protectedNames = await protectedBranches();

  if (protectedNames.includes(name)) {
    return {
      name,
      possible: false,
      safety: 'protected',
      reason:
        `"${name}" is one of the project's shared branches, not a piece of ` +
        'work. It cannot be removed.'
    };
  }

  const { streams, current } = await listWorkstreams();
  const stream = streams.find(s => s.name === name);

  if (!stream) {
    return {
      name,
      possible: false,
      safety: 'missing',
      reason: `There is no workstream called "${name}" any more. Refresh the list.`
    };
  }

  const git = gitService.getGit();

  // Checked against the server's copy of the shared branch *and* the local
  // one, and safe if either contains it.
  //
  // Neither alone is enough. A colleague merges the review and the work is
  // on `origin/develop` while this laptop's `develop` has not moved - local
  // alone calls a merged branch unmerged and refuses to tidy it up. The
  // reverse happens too: work merged here but not yet pushed exists only
  // locally, so the server alone would refuse that one. Containment in
  // either means the commits are not the only copy, which is the whole
  // question being asked.
  const measured = await serverTip(base);

  const targets = measured === base ? [ base ] : [ measured, base ];

  let ancestor = false;
  let contained = false;

  for (const target of targets) {
    if (await isAncestorOf(name, target)) {
      ancestor = true;
      contained = true;
      break;
    }

    if (await isContainedIn(target, name) === true) {
      contained = true;
    }
  }

  const safety = ancestor ? 'merged' : (contained ? 'contained' : 'unmerged');

  const unmergedCount = safety === 'unmerged'
    ? Number((await git.raw([ 'rev-list', '--count', `${measured}..${name}` ]).catch(() => '0')).trim()) || 0
    : 0;

  return {
    name,
    title: humanize(name),
    possible: true,
    safety,

    // `-d` only accepts the first of these; the other two need `-D`.
    needsForce: safety !== 'merged',

    isCurrent: current === name,
    onServer: !!stream.onServer,
    localOnly: !!stream.localOnly,
    unmergedCount,
    base,

    detail: safety === 'merged'
      ? `Everything from "${humanize(name)}" is already in "${base}".`
      : safety === 'contained'
        ? `The work from "${humanize(name)}" is already in "${base}" - it was ` +
          'combined in a way that rewrote the save points, which is what ' +
          'happens when a review is approved with "squash". Nothing is lost ' +
          'by removing it.'
        : `"${humanize(name)}" has ${unmergedCount} save point(s) that are not ` +
          `in "${base}" and are not anywhere else. Removing it would lose them.`
  };
}

/**
 * Remove a workstream.
 *
 * Never force-deletes on the caller's say-so: the plan is recomputed here
 * and `-D` is used only where *this* code has established that the work is
 * already on the shared branch. A panel that could pass `force: true` for
 * anything would put the guardrail on the wrong side of the boundary.
 *
 * Genuinely unmerged work can still be removed, but only with developer
 * mode on - the same line the console draws. An analyst cannot reach a
 * command that discards commits; a developer already has one.
 *
 * Deleting the server copy stays a separate opt-in, because that affects
 * everyone rather than just this computer.
 */
async function deleteWorkstream(name, { alsoOnServer = false, force = false } = {}) {
  const git = gitService.getGit();
  const { base } = await resolveBranches();
  const main = base;

  if ((await protectedBranches()).includes(name)) {
    throw new Error('The shared version cannot be removed.');
  }

  const plan = await planDeleteWorkstream(name);

  if (!plan.possible) {
    throw new Error(plan.reason);
  }

  if (plan.safety === 'unmerged') {
    if (!force) {
      throw new Error(
        `"${plan.title}" has ${plan.unmergedCount} save point(s) that are not ` +
        `in "${base}". Finish it first, or send it to the team so the work ` +
        'exists somewhere else. Nothing has been removed.'
      );
    }

    if (!settingsService.read().developerMode) {
      throw new Error(
        `"${plan.title}" still has work that is not saved anywhere else. ` +
        'Removing it anyway is a developer action - turn on "Developer mode" ' +
        'in Git Settings if that is really what you want.'
      );
    }
  }

  const { current } = await listWorkstreams();

  if (current === name) {
    await git.checkout(main);
  }

  await git.raw([ 'branch', plan.needsForce ? '-D' : '-d', name ]);

  let serverRemoved = false;

  if (alsoOnServer && await gitService.getRemoteUrl('origin')) {
    try {
      await git.push([ 'origin', '--delete', name ]);
      serverRemoved = true;
    } catch (err) {
      // Already gone, or never pushed - not worth failing the cleanup.
    }
  }

  return {
    removed: name,
    title: plan.title,
    safety: plan.safety,
    serverRemoved,
    summary: serverRemoved
      ? `"${plan.title}" has been removed here and on the team server.`
      : `"${plan.title}" has been removed from this computer.` +
        (plan.onServer ? ' It is still on the team server.' : '')
  };
}

module.exports = {
  humanize,
  slugify,
  mergeIntoMain,
  deleteWorkstream,
  planDeleteWorkstream,
  isContainedIn,
  resolveBranches,
  protectedBranches,
  listKnownBranchNames,
  listServerBranchNames,
  publishCurrentBranch,
  pullCurrentBranch,
  rescueDetachedHead,
  assertOnBranch,
  realignUpstream,
  upstreamBranchName,
  remoteBranchExists,
  serverTip,
  guessMainBranch,
  findMainBranch,
  listWorkstreams,
  saveWorkInProgress,
  switchTo,
  createWorkstream
};
