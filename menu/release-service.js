/**
 * The integrator's half of Gitflow: releases, hotfixes, tags, and the
 * dual merges that make them correct.
 *
 * The rest of the plugin serves two roles. An analyst wants "save my work"
 * and never to see a branch name; a developer wants a console and a graph.
 * Neither of them is the person who has to answer "what is actually live,
 * and what is queued behind it" - and that person had nothing here at all,
 * which is why a hotfix could branch from `main`, finish into `develop`, and
 * never reach production without anything reporting a problem.
 *
 * The rule this module exists to enforce:
 *
 *   Under Gitflow, `develop` and `main` never merge into each other
 *   directly. Work crosses between them only on a release or hotfix
 *   branch, and that branch merges into **both** - `main` so it ships and
 *   is tagged, `develop` so the next release still contains it.
 *
 * Missing the second merge is the classic Gitflow failure, and it is
 * invisible: production is correct, everyone is happy, and the fix silently
 * disappears the next time `develop` ships over the top of it. So
 * `integrate()` treats the pair as one operation, and `inspect()` reports a
 * missing back-merge as a first-class finding rather than leaving somebody
 * to notice it in a graph.
 *
 * Nothing here forces or discards. Both merges are `--no-ff` so a release is
 * a visible unit, and a conflict at either stage stops and hands over to the
 * resolver with a clear account of how far it got.
 */

'use strict';

const gitService = require('./git-service');
const branchService = require('./branch-service');
const conflictService = require('./conflict-service');
const configStore = require('./config-store');
const naming = require('./naming');

// Release branches are their own kind, distinct from the three work types
// in naming.js - they are the integrator's object, not a unit of work.
const RELEASE_PREFIX = 'release/';

/**
 * What to call a branch in a sentence.
 *
 * `branchService.humanize()` parses against the three work types in
 * naming.js, and a release branch is not one of them - so `release/1.5.0`
 * comes back as "Release/1.5.0", slash and all. Handled here rather than by
 * adding a fourth type to naming.js, because TYPES also drives the "start a
 * workstream" form, and nobody starts a release by picking it from the same
 * list as "Fix".
 */
function labelFor(branch) {
  const name = String(branch || '');

  if (name.startsWith(RELEASE_PREFIX)) {
    return `Release ${name.slice(RELEASE_PREFIX.length)}`;
  }

  return branchService.humanize(name);
}

/**
 * Semantic-ish version handling.
 *
 * Deliberately lenient about what a tag looks like on the way in (teams use
 * `v1.2.3`, `1.2.3`, `release-1.2.3`) and strict about what it looks like on
 * the way out, so the plugin never invents a third convention in a project
 * that already had one.
 */
function parseVersion(tag) {
  const match = String(tag || '').match(/(\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prefix: /^v/i.test(String(tag).trim()) ? 'v' : ''
  };
}

function formatVersion({ major, minor, patch, prefix }) {
  return `${prefix || ''}${major}.${minor}.${patch}`;
}

/**
 * The next version, given what shipped last.
 *
 * A hotfix bumps the patch and a release bumps the minor - the conventional
 * reading, and only ever a *suggestion*: the caller can pass any version and
 * this is what pre-fills the box.
 */
function suggestVersion(lastTag, kind) {
  const current = parseVersion(lastTag);

  if (!current) {
    return kind === 'hotfix' ? 'v0.0.1' : 'v1.0.0';
  }

  if (kind === 'hotfix') {
    return formatVersion(Object.assign({}, current, { patch: current.patch + 1 }));
  }

  return formatVersion(Object.assign({}, current, {
    minor: current.minor + 1,
    patch: 0
  }));
}

/**
 * A tag name has to survive being handed to `git tag`, and git's own rules
 * (`check-ref-format`) are stricter than they look.
 */
function assertValidTag(name) {
  const clean = String(name || '').trim();

  if (!clean) {
    throw new Error('Give this release a version, for example v1.2.0.');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(clean) || /\.\.|@\{|\.lock$|\/$/.test(clean)) {
    throw new Error(
      `"${clean}" cannot be used as a version. Use letters, numbers, dots ` +
      'and dashes - for example v1.2.0.'
    );
  }

  return clean;
}

async function listTags() {
  const git = gitService.getGit();

  // Sorted by version rather than alphabetically, so v10 does not come
  // before v9, and newest first.
  const raw = await git.raw([
    'for-each-ref', '--sort=-v:refname',
    '--format=%(refname:short)%09%(creatordate:iso8601)%09%(subject)',
    'refs/tags'
  ]).catch(() => '');

  return raw.split('\n').filter(Boolean).map(line => {
    const [ name, date, subject ] = line.split('\t');
    return { name, date: date || null, subject: subject || '' };
  });
}

/**
 * How many commits `head` has that `base` does not.
 *
 * `noMerges` is not a detail - it is the difference between a useful number
 * and a permanent false alarm.
 *
 * A correct Gitflow dual merge leaves the released branch holding its own
 * merge commit, which by construction is not on the integration branch and
 * never will be. Counting every commit therefore reports "1 change on main
 * is not on develop" immediately after the release that got it right, and
 * for every release after that. An alarm that is always on is one people
 * learn to ignore, which is worse than not having it.
 *
 * Counting only non-merge commits asks the question actually worth asking:
 * is there *work* over there that never came back?
 */
async function countBetween(base, head, { noMerges = false } = {}) {
  if (!base || !head || base === head) {
    return 0;
  }

  try {
    const git = gitService.getGit();

    const args = [ 'rev-list', '--count' ];

    if (noMerges) {
      args.push('--no-merges');
    }

    const raw = await git.raw(args.concat(`${base}..${head}`));

    return Number(raw.trim()) || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Do these two branches share any history at all?
 *
 * Gitflow assumes the integration and released branches are one history at
 * two maturities, and every count in this module quietly relies on it. When
 * they are *unrelated* - two independent roots, as happens when a branch is
 * created by a second `git init` or from an orphan - none of those numbers
 * mean anything: `base..release` reports every commit on the far side as
 * "missing", and the back-merge that offers to fix it cannot run at all
 * (`fatal: refusing to merge unrelated histories`).
 *
 * That is nearly always a misconfigured `releaseBranch` pointing at a stray
 * branch rather than a repository that needs repairing, so it is worth
 * saying plainly instead of firing a merge that is guaranteed to fail.
 *
 * `git merge-base` reports "no common ancestor" by exiting non-zero with
 * *empty* output, which simple-git resolves rather than rejects - so the
 * answer has to be read from stdout being blank, not from a thrown error.
 */
async function sharesHistory(a, b) {
  if (!a || !b || a === b) {
    return true;
  }

  try {
    const out = await gitService.getGit().raw([ 'merge-base', a, b ]);

    return !!out.trim();
  } catch (err) {
    return false;
  }
}

/**
 * Branches of a given prefix that currently exist, local or on the server.
 */
async function listBranchesWithPrefix(prefix) {
  const known = await branchService.listKnownBranchNames();

  return [ ...known ].filter(name => name.startsWith(prefix)).sort();
}

/**
 * The whole picture, for the integrator.
 *
 * Every field answers a question somebody actually asks: what is live, what
 * is queued behind it, is anything half-integrated, and is there a release
 * or hotfix in flight right now.
 */
async function inspect() {
  const branches = await branchService.resolveBranches();
  const { base, release, model } = branches;

  if (model !== 'gitflow') {
    return {
      model,
      applicable: false,
      reason:
        'This project uses a single shared version, so there is no separate ' +
        'released branch to integrate into. Releases and hotfixes are part ' +
        'of the Gitflow layout - you can switch to it in Git Settings.',
      base,
      release
    };
  }

  const { status } = await gitService.getStatus();
  const tags = await listTags();

  // Measured against the *server's* copy where we have one: the integrator
  // cares about what the team can see, not about this laptop.
  // Measured against the server's copies, not this clone's.
  //
  // The integrator's questions are all about what the team can see - "what
  // is live", "what is queued" - and answering them from local branches
  // describes one laptop instead. On a machine whose `main` is a week
  // stale that reports work as unreleased which shipped days ago, and
  // raises a missing-back-merge finding for a hotfix that was brought back
  // properly. The comment here used to claim this and the code did not do
  // it; now it does.
  const [ baseRef, releaseRef ] = await Promise.all([
    branchService.serverTip(base),
    branchService.serverTip(release)
  ]);

  // Both counted without merge commits: "how many actual changes", not "how
  // many commits, including the plumbing of how they arrived".
  const [ unreleased, missingBackMerge ] = await Promise.all([
    countBetween(releaseRef, baseRef, { noMerges: true }),
    countBetween(baseRef, releaseRef, { noMerges: true })
  ]);

  // Every count above assumes one shared history. If there is none, they are
  // arithmetic about two unrelated trees and must not be presented as work
  // that went missing.
  const related = await sharesHistory(baseRef, releaseRef);

  const releaseBranches = await listBranchesWithPrefix(RELEASE_PREFIX);
  const hotfixes = await listBranchesWithPrefix(naming.TYPES.hotfix.prefix);

  const lastTag = tags.length ? tags[0].name : null;

  // Local commits on either long-lived branch that the server has not seen.
  //
  // Worth its own finding because of how the counts above are measured:
  // everything else here is read from the server's refs, so immediately
  // after a release the tab still reports the work as queued - which is
  // true for the team, and baffling for the person who just released it.
  // The honest answer is not to change the measurement but to say why.
  const [ unpushedBase, unpushedRelease ] = await Promise.all([
    baseRef === base ? 0 : countBetween(baseRef, base),
    releaseRef === release ? 0 : countBetween(releaseRef, release)
  ]);

  const findings = [];

  if (unpushedBase || unpushedRelease) {
    const parts = [];

    if (unpushedRelease) parts.push(`"${release}"`);
    if (unpushedBase) parts.push(`"${base}"`);

    findings.push({
      id: 'not-sent',
      severity: 'warning',
      title: `${parts.join(' and ')} ${parts.length === 1 ? 'has' : 'have'} changes ` +
        'that are only on this computer',
      detail:
        'A release that has not been sent has not really happened - nobody ' +
        'else can see it, and the next person to release will not have it ' +
        'either. Send both branches from Source Control.',
      fix: null
    });
  }

  // The classic Gitflow failure, and the reason this module exists. Commits
  // on the released branch that never came back to the integration branch
  // will be silently reverted by the next release.
  // Already repaired here, just not sent yet.
  //
  // Everything above is measured from the server, so the moment somebody
  // clicks "bring them back" the warning stays up: the server still shows
  // the gap until the merge is pushed. Telling someone they have not done
  // the thing they just did is how a panel stops being believed - and the
  // "only on this computer" finding below already tells them what remains.
  // Two unrelated trees. Said first and on its own, because every other
  // number on the tab is meaningless until it is fixed - and the fix is a
  // setting, not a merge.
  if (!related) {
    findings.push({
      id: 'unrelated-histories',
      severity: 'warning',
      title: `"${base}" and "${release}" were started separately`,
      detail:
        `These two branches share no common starting point, so nothing can ` +
        `move between them and the counts on this tab do not mean anything. ` +
        `This almost always means "${release}" is not really the released ` +
        `branch - check which branch that should be in Git Settings, under ` +
        `"How this project is organised". Combining them by force would ` +
        `staple two unrelated projects together, so nothing here offers to.`,
      fix: null
    });
  }

  const repairedLocally = missingBackMerge > 0 &&
    await countBetween(base, release, { noMerges: true }) === 0;

  if (related && missingBackMerge > 0 && !repairedLocally) {
    findings.push({
      id: 'missing-back-merge',
      severity: 'warning',
      title: `${missingBackMerge} change(s) on "${release}" are not on "${base}"`,
      detail:
        'This normally means a hotfix went live but was never brought back ' +
        'into everyday work. Unless it is, the next release will quietly ' +
        'undo it.',
      fix: 'back-merge'
    });
  }

  if (releaseBranches.length > 1) {
    findings.push({
      id: 'multiple-releases',
      severity: 'warning',
      title: `${releaseBranches.length} release branches are open at once`,
      detail:
        'Gitflow expects one at a time. Two open releases means it is ' +
        'ambiguous which one ships next.',
      fix: null
    });
  }

  return {
    model,
    applicable: true,
    base,
    release,

    // Carried so the Releases tab can hint the ticket format when starting
    // an urgent fix, without hard-coding a project key the team may have
    // changed.
    projectKey: naming.projectKey(configStore.readConfig()),

    current: status.detached ? null : status.current,
    onRelease: !status.detached && status.current === release,
    onBase: !status.detached && status.current === base,

    lastTag,
    tags: tags.slice(0, 20),

    // "Queued but not live" - the changelog for the next release.
    unreleased,

    // "Live but not queued" - always a bug under Gitflow.
    missingBackMerge,

    unpushedBase,
    unpushedRelease,

    releaseBranches,
    hotfixes,
    inFlight: releaseBranches.concat(hotfixes),

    suggestedRelease: suggestVersion(lastTag, 'release'),
    suggestedHotfix: suggestVersion(lastTag, 'hotfix'),

    findings
  };
}

/**
 * What is going into the next release, as a list somebody can read.
 *
 * `--no-merges` because merge commits are the plumbing of how work arrived,
 * not the work itself: a changelog full of "Merge 'BDM-123 invoice fix'"
 * tells the reader nothing the merged commits do not.
 */
async function unreleasedChanges({ limit = 100 } = {}) {
  const { base, release, model } = await branchService.resolveBranches();

  if (model !== 'gitflow' || !base || !release || base === release) {
    return { applicable: false, changes: [] };
  }

  const git = gitService.getGit();

  // Same reasoning as inspect(): the changelog is "what the team is about
  // to ship", so it is read from the server's refs where they exist.
  const [ baseRef, releaseRef ] = await Promise.all([
    branchService.serverTip(base),
    branchService.serverTip(release)
  ]);

  const raw = await git.raw([
    'log', '--no-merges', `--max-count=${limit}`,
    '--format=%h%x09%an%x09%aI%x09%s',
    `${releaseRef}..${baseRef}`
  ]).catch(() => '');

  const changes = raw.split('\n').filter(Boolean).map(line => {
    const [ short, author, date, subject ] = line.split('\t');
    const parsed = naming.parse(subject || '', {});

    return {
      short,
      author: author || '',
      date: date || null,
      subject: subject || '',

      // Tickets are carried in commit subjects by runSaveMyWork, so the
      // changelog can be grouped by ticket without a Jira round trip.
      ticket: (String(subject).match(/\b[A-Z][A-Z0-9]+-\d+\b/) || [ null ])[0] || parsed.ticket
    };
  });

  return { applicable: true, base, release, changes, total: changes.length };
}

/**
 * Merge one branch into another, reporting a conflict as an outcome.
 *
 * Extracted from branchService.mergeIntoMain() rather than reused because
 * that one is hard-wired to the base branch and to "the shared version"
 * wording. The mechanics are the same and the same warning applies: `git
 * merge` reports a conflict on stdout and resolves rather than rejecting, so
 * the output has to be inspected and the on-disk marker trusted over it.
 */
async function mergeInto(target, source, message) {
  const git = gitService.getGit();

  await git.checkout(target);

  let output = '';

  try {
    output = await git.raw([ 'merge', '--no-ff', source, '-m', message ]);
  } catch (err) {
    output = (err && err.message) || '';

    if (!/conflict/i.test(output)) {
      throw err;
    }
  }

  const conflicted = /conflict/i.test(output) || conflictService.isMergeInProgress();

  return { target, source, conflicted };
}

/**
 * Everything that has to be true before a release can be integrated, and
 * what integrating would do.
 *
 * This exists because integrating is the least forgiving operation in the
 * plugin. It writes to both long-lived branches and creates a tag, and a
 * tag that has been pushed is the one thing here that is genuinely awkward
 * to retract - other people's tooling will have seen it. Everything else
 * previews before it acts; this had no preview at all, which was exactly
 * backwards.
 *
 * The checks are ordered by how bad it is to get them wrong:
 *
 *   blockers - would produce a wrong or unpushable result. Refused.
 *   steps    - safe repairs done as part of the operation, listed so they
 *              are not a surprise.
 *   warnings - probably fine, worth reading first.
 *
 * `refresh` fetches before checking. Every one of these questions is about
 * what the server has, and answering them from stale refs is how you
 * discover at push time that somebody else released twenty minutes ago.
 */
async function planIntegrate({ branch, version, refresh = true } = {}) {
  const branches = await branchService.resolveBranches();
  const { base, release, model } = branches;

  if (model !== 'gitflow') {
    return {
      possible: false,
      blockers: [ {
        id: 'not-gitflow',
        title: 'This project has a single shared version',
        detail: 'There is no separate released branch to integrate into. ' +
          'Use "I\'m finished with this" instead.'
      } ]
    };
  }

  const git = gitService.getGit();
  const hasRemote = !!(await gitService.getRemoteUrl('origin'));

  if (refresh && hasRemote) {
    // Tags included: a version that already exists on the server is the
    // check most likely to be wrong from stale refs, and the most annoying
    // to discover after both merges have already happened.
    try {
      await git.fetch([ 'origin', '--prune', '--tags' ]);
    } catch (err) {
      // Offline. The checks below still run against what is known; the
      // warning about being unable to send covers the rest.
    }
  }

  const { status } = await gitService.getStatus();

  const target = String(branch || (status.detached ? '' : status.current) || '');
  const isRelease = target.startsWith(RELEASE_PREFIX);
  const isHotfix = target.startsWith(naming.TYPES.hotfix.prefix);
  const kind = isRelease ? 'release' : isHotfix ? 'hotfix' : null;

  const blockers = [];
  const warnings = [];
  const steps = [];

  // --- can we act at all? ----------------------------------------------

  if (conflictService.isMergeInProgress()) {
    blockers.push({
      id: 'in-progress',
      title: 'Something is half-finished',
      detail: 'Finish or cancel the merge that is open before releasing.'
    });
  }

  // A release writes to both long-lived branches, so it cannot even start
  // when they are unrelated - the second merge would fail after the first
  // had already landed and been tagged.
  if (!(await sharesHistory(base, release))) {
    blockers.push({
      id: 'unrelated-histories',
      title: `"${base}" and "${release}" were started separately`,
      detail:
        'They share no common history, so a release cannot move between ' +
        `them. Check which branch is really the released one in Git ` +
        'Settings, under "How this project is organised".'
    });
  }

  if (status.detached) {
    blockers.push({
      id: 'detached',
      title: 'You are not on a workstream',
      detail: 'Get back onto a branch before releasing.'
    });
  }

  if (!kind) {
    blockers.push({
      id: 'not-releasable',
      title: `"${target || 'this branch'}" is not a release or an urgent fix`,
      detail: 'Only a release branch or a hotfix goes live on ' +
        `"${release}". Cut a release from "${base}" first.`
    });
  }

  if (blockers.length) {
    return { possible: false, blockers, branch: target, base, release, kind };
  }

  // --- is there anything to release? -----------------------------------

  const commits = await countBetween(release, target, { noMerges: true });

  if (!commits) {
    blockers.push({
      id: 'nothing-to-do',
      title: 'There is nothing here that is not already live',
      detail: `Everything on "${target}" is already on "${release}".`
    });
  }

  // --- version ----------------------------------------------------------

  const tags = await listTags();
  const lastTag = tags.length ? tags[0].name : null;

  const suggested = suggestVersion(lastTag, kind === 'hotfix' ? 'hotfix' : 'release');
  const wanted = String(version || suggested).trim();

  let tag = null;

  try {
    tag = assertValidTag(wanted);
  } catch (err) {
    blockers.push({ id: 'bad-version', title: 'That version cannot be used', detail: err.message });
  }

  if (tag && tags.some(t => t.name === tag)) {
    blockers.push({
      id: 'tag-exists',
      title: `${tag} already exists`,
      detail: 'Every release needs its own version. Pick the next one - ' +
        `the last one used was ${lastTag}.`
    });
  }

  if (tag && lastTag) {
    const previous = parseVersion(lastTag);
    const next = parseVersion(tag);

    if (previous && next) {
      const back = next.major < previous.major ||
        (next.major === previous.major && next.minor < previous.minor) ||
        (next.major === previous.major && next.minor === previous.minor &&
          next.patch < previous.patch);

      if (back) {
        warnings.push(
          `${tag} is lower than the last release, ${lastTag}. That is allowed, ` +
          'but it usually means a digit was mistyped.'
        );
      }
    }
  }

  // --- is everyone's copy current? --------------------------------------

  const [ ownServer, releaseServer, baseServer ] = await Promise.all([
    branchService.serverTip(target),
    branchService.serverTip(release),
    branchService.serverTip(base)
  ]);

  const behindOwn = ownServer === target ? 0 : await countBetween(target, ownServer);

  if (behindOwn) {
    blockers.push({
      id: 'branch-behind',
      title: `Somebody else has added to "${target}"`,
      detail: `The server has ${behindOwn} change(s) on this branch that you ` +
        'do not. Releasing now would leave them out. Get in step with the ' +
        'team first.'
    });
  }

  const checkLongLived = async (name, serverRef) => {
    if (serverRef === name) {
      return;
    }

    const behind = await countBetween(name, serverRef);
    const ahead = await countBetween(serverRef, name);

    if (behind && ahead) {
      blockers.push({
        id: `diverged-${name}`,
        title: `"${name}" has gone in two directions`,
        detail: `Your copy and the server's have each moved on. This has to ` +
          'be sorted out before a release can be built on it - use "Get in ' +
          `step with the team" on "${name}".`
      });
      return;
    }

    if (behind) {
      steps.push({
        key: `update-${name}`,
        label: `Bring "${name}" up to date with the server first (${behind} change(s))`
      });
    }
  };

  await Promise.all([
    checkLongLived(release, releaseServer),
    checkLongLived(base, baseServer)
  ]);

  // --- what it will do ---------------------------------------------------

  steps.push({ key: 'merge-release', label: `Put it onto "${release}"` });
  steps.push({ key: 'tag', label: `Mark that point as ${tag || wanted}` });
  steps.push({ key: 'merge-base', label: `Bring it back into "${base}"` });
  steps.push({ key: 'cleanup', label: `Remove the "${target}" branch` });

  if (hasRemote) {
    steps.push({
      key: 'push',
      label: `Send "${release}", "${base}" and ${tag || wanted} to the team`
    });
  } else {
    warnings.push(
      'This project has no team server, so the release stays on this ' +
      'computer only.'
    );
  }

  warnings.push(
    'Both branches are written, not just one - that is what stops the next ' +
    'release quietly undoing this.'
  );

  if (hasRemote) {
    warnings.push(
      `Once ${tag || wanted} is sent it is public: other people's tools will ` +
      'see it, so it is awkward to take back. The merges themselves can be ' +
      'undone normally.'
    );
  }

  return {
    possible: !blockers.length,
    blockers,
    warnings,
    steps,
    branch: target,
    kind,
    base,
    release,
    version: tag || wanted,
    suggested,
    lastTag,
    commits,
    hasRemote
  };
}

/**
 * The dual merge, as one operation.
 *
 * Order matters and is not arbitrary: the released branch goes first,
 * because that is the one somebody is waiting on, and because tagging it is
 * what makes the release exist. If the back-merge then conflicts, the
 * release has still shipped and the outstanding work is visible and named
 * rather than lost.
 *
 * Every step is reported, including the ones that did not run, so a stop
 * halfway is a description rather than a mystery.
 */
async function integrate({ branch, version, deleteWhenDone = true, send = true }) {

  // The plan is recomputed here rather than trusted from the caller. Every
  // check it makes is a reason not to proceed, and a guard that lives in
  // the panel is a guard a second caller will not have.
  const plan = await planIntegrate({ branch, version });

  if (!plan.possible) {
    const first = plan.blockers[0];
    throw new Error(`${first.title}. ${first.detail}`);
  }

  const { base, release, kind } = plan;
  const target = plan.branch;
  const tag = plan.version;

  const git = gitService.getGit();
  const steps = [];

  // Any uncommitted work belongs to whoever is sitting here, not to the
  // release - commit it before checking anything out.
  const autoSaved = await branchService.saveWorkInProgress();

  if (autoSaved) {
    steps.push({ key: 'save', ok: true, label: `Saved ${autoSaved.saved} change(s) first` });
  }

  // --- 0. bring the long-lived branches up to date ---------------------
  //
  // Building a release on a stale `main` produces a merge the server will
  // reject, after both merges and the tag have already happened - the worst
  // possible moment to find out. planIntegrate() has already established
  // these are behind and not diverged, so this can only fast-forward.

  for (const name of [ release, base ]) {
    const serverRef = await branchService.serverTip(name);

    if (serverRef === name) {
      continue;
    }

    const behind = await countBetween(name, serverRef);

    if (!behind) {
      continue;
    }

    try {
      await git.checkout(name);
      await git.raw([ 'merge', '--ff-only', serverRef ]);

      steps.push({
        key: `update-${name}`,
        ok: true,
        label: `Brought "${name}" up to date (${behind} change(s))`
      });
    } catch (err) {
      throw new Error(
        `Could not bring "${name}" up to date with the server, so the ` +
        `release was not started. Nothing has been changed. (${err.message})`
      );
    }
  }

  // --- 1. into the released branch ------------------------------------

  const label = labelFor(target);
  const toRelease = await mergeInto(release, target, `Release "${label}"`);

  if (toRelease.conflicted) {
    steps.push({
      key: 'merge-release',
      ok: false,
      label: `Combining into "${release}" needs a decision`
    });

    return {
      ok: true,
      needsDecision: true,
      stage: 'release',
      branch: target, release, base, tag,
      steps,
      summary:
        `Putting "${label}" into "${release}" hit changes to the same ` +
        'diagrams. Choose which version to keep and finish up - then run ' +
        'this again to tag it and bring it back into everyday work.'
    };
  }

  steps.push({ key: 'merge-release', ok: true, label: `Combined into "${release}"` });

  // --- 2. tag it -------------------------------------------------------

  if (tag) {
    try {
      await git.raw([ 'tag', '-a', tag, '-m', `${tag}` ]);
      steps.push({ key: 'tag', ok: true, label: `Marked it as ${tag}` });
    } catch (err) {
      // An existing tag is the likely cause and is not worth undoing a
      // correct merge over.
      steps.push({
        key: 'tag',
        ok: false,
        label: `Could not mark it as ${tag}`,
        detail: err.message
      });
    }
  }

  // --- 3. back into the integration branch -----------------------------
  //
  // The *branch* is merged into base, not the released branch. Merging
  // `main` into `develop` would drag every earlier release commit along
  // with it; merging the hotfix itself brings exactly the change that is
  // missing.

  const toBase = await mergeInto(base, target, `Bring "${label}" back into ${base}`);

  if (toBase.conflicted) {
    steps.push({
      key: 'merge-base',
      ok: false,
      label: `Bringing it back into "${base}" needs a decision`
    });

    return {
      ok: true,
      needsDecision: true,
      stage: 'base',
      branch: target, release, base, tag,
      steps,
      summary:
        `"${label}" is live on "${release}"${tag ? ` and marked ${tag}` : ''}. ` +
        `Bringing it back into "${base}" hit changes to the same diagrams - ` +
        'choose which version to keep and finish up. Nothing is lost, and ' +
        'the release itself is done.'
    };
  }

  steps.push({ key: 'merge-base', ok: true, label: `Brought it back into "${base}"` });

  // --- 4. tidy up ------------------------------------------------------

  let removed = false;

  if (deleteWhenDone) {
    try {
      await branchService.deleteWorkstream(target, { alsoOnServer: false });
      removed = true;
      steps.push({ key: 'cleanup', ok: true, label: `Removed "${label}"` });
    } catch (err) {
      // Never fatal: it is merged into both branches, which was the point.
      steps.push({
        key: 'cleanup',
        ok: false,
        label: 'Left the branch in place',
        detail: err.message
      });
    }
  }

  // --- 5. send it -------------------------------------------------------
  //
  // On by default, and the preview says so. A release nobody can see is not
  // a release: it is two local merges and a tag that the next person to
  // integrate will collide with. Leaving both branches sitting here is
  // exactly why `inspect()` needed a finding for it.
  //
  // Explicit refspecs, never a bare push, for the same reason
  // publishCurrentBranch() uses them - the destination is never left to
  // `push.default`. Nothing is forced.

  let sent = false;

  if (send && plan.hasRemote) {
    try {
      await git.push([ 'origin', `${release}:${release}`, `${base}:${base}` ]);
      await git.push([ 'origin', tag ]);

      sent = true;
      steps.push({
        key: 'push',
        ok: true,
        label: `Sent "${release}", "${base}" and ${tag} to the team`
      });
    } catch (err) {
      steps.push({
        key: 'push',
        ok: false,
        label: 'Could not send it to the team',
        detail: err.message
      });
    }
  }

  return {
    ok: true,
    needsDecision: false,
    kind,
    branch: target, release, base, tag,
    removed,
    sent,
    steps,
    summary: sent
      ? `${tag} is live. "${label}" is on "${release}", back on "${base}", ` +
        'and the team has all of it.'
      : `"${label}" is now on "${release}"${tag ? `, marked ${tag},` : ''} and ` +
        `back on "${base}"` +
        (plan.hasRemote
          ? ' - but it could not be sent, so nobody else has it yet.'
          : '. This project has no team server, so it stays here.')
  };
}

/**
 * Repair a missing back-merge.
 *
 * The one case where merging the released branch into the integration
 * branch directly *is* right: the change is already live and its own branch
 * is long gone, so there is nothing else left to merge.
 */
async function backMerge() {
  const { base, release, model } = await branchService.resolveBranches();

  if (model !== 'gitflow') {
    throw new Error('This project has only one shared version, so there is nothing to bring back.');
  }

  // Measured, and merged, from the server's copy: the whole point is to
  // recover work that went live without coming back, and a local `main`
  // that has not been fetched does not have it either.
  const releaseRef = await branchService.serverTip(release);
  const baseRef = await branchService.serverTip(base);

  // Checked before anything is attempted: without a common ancestor this
  // merge cannot succeed, and git's own refusal ("unrelated histories") gets
  // translated into advice about pulling from the server, which is not what
  // failed and would not help.
  if (!(await sharesHistory(baseRef, releaseRef))) {
    throw new Error(
      `"${base}" and "${release}" were started separately and share no ` +
      `common history, so nothing can be brought back between them. This ` +
      `usually means "${release}" is not really the released branch - check ` +
      'which branch that should be in Git Settings, under "How this project ' +
      'is organised". Nothing has been changed.'
    );
  }

  const outstanding = await countBetween(baseRef, releaseRef, { noMerges: true });

  if (!outstanding) {
    throw new Error(`"${base}" already has everything that is on "${release}".`);
  }

  await branchService.saveWorkInProgress();

  // Merged into the *local* base, because that is what can be committed on
  // and pushed - the source is the remote-tracking ref, exactly as a pull
  // would do it.
  const result = await mergeInto(
    base, releaseRef, `Bring "${release}" back into ${base}`
  );

  if (result.conflicted) {
    return {
      ok: true,
      needsDecision: true,
      summary:
        `Bringing "${release}" back into "${base}" hit changes to the same ` +
        'diagrams. Choose which version to keep and finish up - nothing is lost.'
    };
  }

  return {
    ok: true,
    needsDecision: false,
    merged: outstanding,
    summary:
      `"${base}" now has the ${outstanding} change(s) that were only on ` +
      `"${release}". Send it to the team so everyone has them.`
  };
}

/**
 * Cut a release branch off the integration branch.
 *
 * The point of the branch is that `develop` carries on moving while the
 * release is stabilised, so this is deliberately a branch rather than
 * tagging `develop` where it stands.
 */
async function startRelease(version) {
  const { base, release, model } = await branchService.resolveBranches();

  if (model !== 'gitflow') {
    throw new Error('Release branches are part of the Gitflow layout, which this project does not use.');
  }

  const tag = assertValidTag(version);
  const name = `${RELEASE_PREFIX}${tag.replace(/^v/i, '')}`;

  const known = await branchService.listKnownBranchNames();

  if (known.has(name)) {
    throw new Error(`A release branch called "${name}" already exists.`);
  }

  const ahead = await countBetween(
    await branchService.serverTip(release),
    await branchService.serverTip(base),
    { noMerges: true }
  );

  if (!ahead) {
    throw new Error(
      `"${base}" has nothing that is not already on "${release}", so there ` +
      'is nothing to release.'
    );
  }

  const autoSaved = await branchService.saveWorkInProgress();
  const git = gitService.getGit();

  // From the server's copy where there is one, for the same reason starting
  // a workstream does: cutting a release from a stale local branch ships
  // something nobody reviewed.
  let from = base;

  if (await gitService.getRemoteUrl('origin')) {
    try {
      await git.fetch([ 'origin', base, '--prune' ]);
      from = `origin/${base}`;
    } catch (err) {
      from = base;
    }
  }

  await git.checkout([ '-b', name, '--no-track', from ]);

  return {
    ok: true,
    name,
    version: tag,
    from,
    changes: ahead,
    autoSaved,
    summary:
      `Release "${name}" started from ${from}, with ${ahead} change(s) in it. ` +
      `Everyday work carries on on "${base}" - when this is ready, finish it ` +
      'to put it live and mark it.'
  };
}

module.exports = {
  RELEASE_PREFIX,
  labelFor,
  inspect,
  planIntegrate,
  unreleasedChanges,
  listTags,
  integrate,
  backMerge,
  startRelease,
  suggestVersion,
  parseVersion,
  formatVersion,
  assertValidTag,
  countBetween,
  sharesHistory,
  mergeInto
};
