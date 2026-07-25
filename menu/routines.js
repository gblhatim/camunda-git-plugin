/**
 * Routines: task-level workflows for people who do not use git directly.
 *
 * A routine bundles several git commands behind one plain-language action
 * ("Save my work") and reports what it did in the same plain language.
 *
 * Two rules every routine here follows:
 *
 *  1. It can be previewed. `plan()` describes what would happen without
 *     changing anything, so the UI can show "this will do X, Y, Z" before
 *     the user commits to it.
 *
 *  2. It never leaves work unrecoverable. Local saving happens before any
 *     network step, so if the network half fails the user's work is still
 *     committed on their own branch and nothing needs undoing. No routine
 *     force-pushes, discards, or resets.
 */

'use strict';

const gitService = require('./git-service');
const branchService = require('./branch-service');
const remoteService = require('./remote-service');
const configStore = require('./config-store');
const conflictService = require('./conflict-service');
const releaseService = require('./release-service');
const gitErrors = require('./git-errors');
const naming = require('./naming');

/**
 * Describe what "Save my work" would do, without doing it.
 */
async function planSaveMyWork() {
  const { branch, status } = await gitService.getStatus();

  const changed = status.files.length;
  const remoteUrl = await gitService.getRemoteUrl('origin');
  const hasRemote = !!remoteUrl;

  const steps = [];
  const warnings = [];

  if (!changed) {
    return {
      routine: 'save-my-work',
      possible: false,
      reason: 'There is nothing to save - none of your diagrams have changed.',
      branch,
      steps: [],
      warnings: []
    };
  }

  steps.push({
    key: 'stage',
    label: `Collect your ${changed} changed ${changed === 1 ? 'diagram' : 'diagrams'}`
  });

  steps.push({
    key: 'commit',
    label: 'Create a save point on your branch'
  });

  if (hasRemote) {
    steps.push({
      key: 'push',
      label: 'Send the save point to the team'
    });
  } else {
    warnings.push(
      'This project has no team server set up, so your work will be saved ' +
      'on this computer only.'
    );
  }

  if (status.behind) {
    warnings.push(
      `The team has ${status.behind} newer change(s). Your work will be saved ` +
      'either way, but sending may be refused until you get their updates.'
    );
  }

  return {
    routine: 'save-my-work',
    possible: true,
    branch,
    fileCount: changed,
    files: status.files.map(f => f.path),
    willPush: hasRemote,
    steps,
    warnings
  };
}

/**
 * Run "Save my work": collect every change, make a save point, send it.
 *
 * Returns a per-step outcome list rather than throwing, because a partial
 * success is the interesting case: if the commit worked and the push did
 * not, the user has lost nothing and needs to be told exactly that.
 */
async function runSaveMyWork(message) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Please describe what you changed first.');
  }

  const plan = await planSaveMyWork();

  if (!plan.possible) {
    throw new Error(plan.reason);
  }

  const done = [];

  // The ticket the branch belongs to goes on the front of the message, so
  // `git log --oneline` stays scannable by ticket without anyone having to
  // remember the convention. Already-mentioned tickets are left alone.
  const config = configStore.readConfig();
  const { ticket } = naming.parse(plan.branch, config);
  const fullMessage = naming.applyTicketToMessage(message, ticket);

  // --- local half: after this, the user's work is safe -----------------

  await gitService.stageAll();
  done.push({
    key: 'stage',
    ok: true,
    label: `Collected ${plan.fileCount} ${plan.fileCount === 1 ? 'diagram' : 'diagrams'}`
  });

  const commit = await gitService.commitStaged(fullMessage);
  done.push({
    key: 'commit',
    ok: true,
    label: 'Created a save point',
    detail: commit.commit || ''
  });

  if (!plan.willPush) {
    return {
      ok: true,
      steps: done,
      summary: 'Your work is saved on this computer.'
    };
  }

  // --- network half: failure here is reported, never fatal --------------

  try {
    await branchService.publishCurrentBranch();
    done.push({ key: 'push', ok: true, label: 'Sent to the team' });

    return {
      ok: true,
      steps: done,
      summary: 'Your work is saved and the team can see it.'
    };
  } catch (err) {
    done.push({
      key: 'push',
      ok: false,
      label: 'Could not send to the team',
      detail: err.message || String(err)
    });

    return {
      ok: true,
      partial: true,
      steps: done,
      summary:
        'Your work is saved safely on this computer, but it could not be sent ' +
        'to the team. Try "Get updates" and then send again - nothing is lost.'
    };
  }
}

// ---------------------------------------------------------------------
// "I'm finished with this"
// ---------------------------------------------------------------------

/**
 * How finished work rejoins the shared version, from Repository Settings.
 * Defaults to review: letting unreviewed diagrams reach everyone should be
 * a decision someone made on purpose, not the fallback.
 */
function getMergePolicy() {
  const config = configStore.readConfig();
  return config.mergePolicy === 'direct' ? 'direct' : 'review';
}

/**
 * Where a finished branch is supposed to go.
 *
 * Under a trunk model there is one answer and this is a formality. Under
 * Gitflow it is the whole question, and getting it wrong is silent: a
 * hotfix branches off the released branch, finishes into the integration
 * branch, and production never receives the fix that the branch name
 * promises. Nothing errors, and the preview cheerfully says it combined
 * into the shared version.
 *
 * So the destination is derived from the *kind of work*, the same way the
 * starting point already was:
 *
 *   feature / bugfix -> the integration branch, on its own
 *   hotfix / release -> both branches, and a version marker
 */
async function finishRouteFor(branch) {
  const config = configStore.readConfig();
  const branches = await branchService.resolveBranches();

  const gitflow = branches.model === 'gitflow';
  const parsed = naming.parse(branch, config);

  const isRelease = String(branch || '').startsWith(releaseService.RELEASE_PREFIX);
  const dual = gitflow && (isRelease || parsed.type === 'hotfix');

  return {
    dual,
    kind: isRelease ? 'release' : parsed.type,
    base: branches.base,
    release: branches.release,
    target: dual ? branches.release : branches.base,
    model: branches.model
  };
}

async function planFinish() {
  const { branch, status } = await gitService.getStatus();
  const main = await branchService.findMainBranch();
  const policy = getMergePolicy();
  const hasRemote = !!(await gitService.getRemoteUrl('origin'));

  // Both long-lived branches, not just the base one. The old check compared
  // against `base` alone, which is the same branch as `release` under a
  // trunk model and therefore looked complete - but under Gitflow it left
  // the released branch unguarded, so pressing "finish" while standing on
  // `main` merged main straight into develop. That is a direct interaction
  // between the two branches Gitflow specifically keeps apart.
  const longLived = await branchService.protectedBranches();

  if (longLived.includes(branch)) {
    return {
      routine: 'finish',
      possible: false,
      reason:
        `You are on "${branch}", which is one of the project's shared ` +
        'branches rather than a piece of work. Start something new, or ' +
        'switch to the workstream you want to finish.'
    };
  }

  const route = await finishRouteFor(branch);

  // A hotfix or a release is the integrator's operation: it goes to two
  // branches and carries a version. Answering it here with a single merge
  // would be the bug this route exists to prevent.
  if (route.dual) {
    const info = await releaseService.inspect();

    return {
      routine: 'finish',
      possible: false,
      handOff: 'release',
      kind: route.kind,
      target: route.target,
      base: route.base,
      suggestedVersion: route.kind === 'release'
        ? info.suggestedRelease
        : info.suggestedHotfix,
      reason:
        route.kind === 'hotfix'
          ? `This is an urgent fix, so it has to go live on "${route.release}" ` +
            `*and* come back into "${route.base}" - otherwise the next ` +
            'release undoes it. Use the Releases tab, which does both and ' +
            'marks the version.'
          : `This is a release branch, so it goes live on "${route.release}" ` +
            `and back into "${route.base}". Use the Releases tab, which does ` +
            'both and marks the version.'
    };
  }

  const steps = [];
  const warnings = [];

  if (status.files.length) {
    steps.push({
      key: 'save',
      label: `Save your ${status.files.length} unsaved ${status.files.length === 1 ? 'change' : 'changes'} first`
    });
  }

  if (policy === 'review') {
    if (!hasRemote) {
      return {
        routine: 'finish',
        possible: false,
        reason:
          'This project has no team server, so there is nowhere to send the ' +
          'work for review. Change the setting to "Merge directly" in ' +
          'Repository Settings if you work on your own.'
      };
    }

    steps.push({ key: 'push', label: 'Send your workstream to the team server' });
    steps.push({ key: 'review', label: 'Open a review request in your browser' });

    warnings.push(
      'Your work will not reach the shared version until someone approves ' +
      'the review.'
    );
  } else {
    if (hasRemote) {
      steps.push({ key: 'push', label: 'Send your workstream to the team server' });
    }

    steps.push({ key: 'merge', label: `Combine it into the shared version (${branchService.humanize(main)})` });

    if (hasRemote) {
      steps.push({ key: 'push-main', label: 'Send the combined result to the team' });
    }

    warnings.push(
      'This puts your work into the shared version immediately, without ' +
      'anyone reviewing it first.'
    );
  }

  return {
    routine: 'finish',
    possible: true,
    policy,
    branch,
    title: branchService.humanize(branch),
    main,
    fileCount: status.files.length,
    steps,
    warnings
  };
}

/**
 * Run the finish routine.
 *
 * Like runSaveMyWork, this reports per-step outcomes rather than throwing:
 * a merge that stops on a conflict is a normal, recoverable state that the
 * conflict resolver takes over, not a failure.
 */
async function runFinish() {
  const plan = await planFinish();

  if (!plan.possible) {
    throw new Error(plan.reason);
  }

  const done = [];
  const branch = plan.branch;

  // Local save first - the invariant every routine keeps.
  const autoSaved = await branchService.saveWorkInProgress();

  if (autoSaved) {
    done.push({
      key: 'save',
      ok: true,
      label: `Saved ${autoSaved.saved} change(s)`
    });
  }

  if (plan.policy === 'review') {
    await branchService.publishCurrentBranch();
    done.push({ key: 'push', ok: true, label: 'Sent to the team server' });

    const remoteUrl = await gitService.getRemoteUrl('origin');
    const info = remoteService.parseRemote(remoteUrl);

    const url = info.isGitLab
      ? remoteService.buildGitLabMrUrl(info, branch, plan.main)
      : remoteService.buildGitHubCompareUrl(info, plan.main, branch);

    done.push({ key: 'review', ok: true, label: 'Opened a review request' });

    return {
      ok: true,
      policy: 'review',
      steps: done,
      openUrl: url,
      summary:
        'Your work is with the team for review. It joins the shared version ' +
        'once someone approves it.'
    };
  }

  // --- direct ----------------------------------------------------------

  if (await gitService.getRemoteUrl('origin')) {
    try {
      await branchService.publishCurrentBranch();
      done.push({ key: 'push', ok: true, label: 'Sent your workstream to the team server' });
    } catch (err) {
      done.push({
        key: 'push',
        ok: false,
        label: 'Could not send your workstream (continuing anyway)',
        detail: err.message
      });
    }
  }

  const merge = await branchService.mergeIntoMain(branch);

  if (merge.needsDecision) {
    done.push({
      key: 'merge',
      ok: false,
      label: 'Some diagrams need a decision before combining'
    });

    return {
      ok: true,
      needsDecision: true,
      policy: 'direct',
      steps: done,
      summary:
        'You and the team changed the same diagrams. Choose which version ' +
        'to keep below, then finish up - nothing is lost either way.'
    };
  }

  done.push({ key: 'merge', ok: true, label: 'Combined into the shared version' });

  if (await gitService.getRemoteUrl('origin')) {
    try {
      await branchService.publishCurrentBranch();
      done.push({ key: 'push-main', ok: true, label: 'Sent the shared version to the team' });
    } catch (err) {
      done.push({
        key: 'push-main',
        ok: false,
        label: 'Combined locally, but could not send it to the team',
        detail: err.message
      });

      return {
        ok: true,
        partial: true,
        policy: 'direct',
        finishedBranch: branch,
        steps: done,
        summary:
          'Your work is combined on this computer but not sent yet. Try ' +
          '"Send" once you are back online - nothing is lost.'
      };
    }
  }

  // Tidy the finished workstream away.
  //
  // The merge above succeeded, so every commit on the workstream is now on
  // the shared version - the branch is a spent label, and leaving it behind
  // is what made the workstream list silently accumulate finished work over
  // time. deleteWorkstream() recomputes its own safety check and, because
  // the `--no-ff` merge makes the tip an ancestor of the shared branch, sees
  // it as fully merged: a plain `-d`, no force, no developer-mode gate.
  //
  // Never fatal. The work is safely combined whether or not the label goes,
  // so a cleanup that cannot run is a note, not a failure - exactly how
  // integrate() treats the same step. The server copy is left alone: it was
  // just pushed to, deleting it affects everyone, and it stays a separate
  // opt-in for the same reason it is everywhere else in the plugin.
  let removed = false;

  try {
    const cleanup = await branchService.deleteWorkstream(branch, { alsoOnServer: false });
    removed = true;
    done.push({ key: 'cleanup', ok: true, label: `Tidied away "${cleanup.title}"` });
  } catch (err) {
    done.push({
      key: 'cleanup',
      ok: false,
      label: 'Left the workstream in place',
      detail: err.message
    });
  }

  return {
    ok: true,
    policy: 'direct',
    finishedBranch: branch,
    removed,
    steps: done,
    summary: `"${plan.title}" is now part of the shared version.`
      + (removed ? '' : ` The "${plan.title}" workstream is still here to remove by hand.`)
  };
}

// ---------------------------------------------------------------------
// "Get back in step with the team"
// ---------------------------------------------------------------------

/**
 * The round trip, as one action.
 *
 * Everything needed to be in step with the team already existed - refresh
 * what the server has, get their updates, send yours - but only as three
 * separate buttons that have to be pressed in the right order. Get that
 * order wrong and git refuses: sending before getting fails with
 * "non-fast-forward", which is the single most common way somebody ends up
 * stuck, and the fix is simply to have done it the other way round.
 *
 * So the order is the feature. Save local work, refresh, get, then send -
 * each step only if it applies, and the whole thing stops rather than
 * pushing if a conflict appears in the middle.
 *
 * It also *reports the drift* it finds while it is in there. A fetch is the
 * only moment the plugin learns that a workstream was deleted on the server
 * or that three new ones appeared, and that is exactly the information
 * somebody re-syncing is looking for. Saying "up to date" without mentioning
 * that the branch you are on no longer exists on the server would be
 * technically true and useless.
 *
 * Nothing here forces, resets or discards. The worst outcome is a conflict,
 * which is the resolver's job and is reported as an outcome rather than a
 * failure.
 */
async function planSync() {
  const { branch, status } = await gitService.getStatus();

  if (conflictService.isMergeInProgress()) {
    return {
      routine: 'sync',
      possible: false,
      reason:
        'Something is half-finished and needs sorting out first. Finish or ' +
        'cancel it, then get back in step.'
    };
  }

  if (status.detached) {
    return {
      routine: 'sync',
      possible: false,
      reason:
        'You are looking at an old version rather than working on a ' +
        'workstream, so there is nothing to keep in step. Get back on a ' +
        'workstream first.'
    };
  }

  if (!(await gitService.getRemoteUrl('origin'))) {
    return {
      routine: 'sync',
      possible: false,
      reason:
        'This project has no team server, so there is nothing to get in step ' +
        'with. Everything is already saved on this computer.'
    };
  }

  const steps = [];
  const warnings = [];

  if (status.files.length) {
    steps.push({
      key: 'save',
      label: `Save your ${status.files.length} unsaved ` +
        `${status.files.length === 1 ? 'change' : 'changes'} first`
    });
  }

  steps.push({
    key: 'refresh',
    label: 'Check what the team server actually has now'
  });

  steps.push({
    key: 'update',
    label: status.behind
      ? `Get the team's ${status.behind} ${status.behind === 1 ? 'change' : 'changes'}`
      : "Get anything new from the team"
  });

  // The step that was missing. Without it, a workstream stays behind the
  // shared branch no matter how many times somebody presses this.
  const catchUp = await baseCatchUp();

  if (catchUp.applicable && catchUp.behind) {
    steps.push({
      key: 'catch-up',
      label: `Bring the ${catchUp.behind} ` +
        `${catchUp.behind === 1 ? 'change' : 'changes'} from "${catchUp.base}" ` +
        'into your workstream'
    });

    warnings.push(
      `Your workstream started before ${catchUp.behind} of the team's ` +
      `${catchUp.behind === 1 ? 'change' : 'changes'} to "${catchUp.base}". ` +
      'Bringing them in now means finishing later is a small step rather ' +
      'than a large one.'
    );
  }

  const sending = status.ahead || !status.tracking;

  steps.push({
    key: 'send',
    label: sending && status.ahead
      ? `Send your ${status.ahead} save ${status.ahead === 1 ? 'point' : 'points'}`
      : 'Send anything of yours the team does not have'
  });

  if (status.behind && status.ahead) {
    warnings.push(
      'You and the team have both made changes. They will be combined - if ' +
      'the same diagrams were changed on both sides you will be asked to ' +
      'choose, and nothing is lost either way.'
    );
  }

  return {
    routine: 'sync',
    possible: true,
    branch,
    title: branchService.humanize(branch),
    ahead: status.ahead,
    behind: status.behind,
    fileCount: status.files.length,
    steps,
    warnings
  };
}

/**
 * How far the current workstream has fallen behind the shared branch, and
 * where to catch it up from.
 *
 * This is a different question from `status.behind`, and conflating them is
 * a mistake with real consequences. `status.behind` counts what the
 * *branch's own counterpart* on the server has - `origin/feature/x` - so
 * when a colleague pushes to `develop` it stays resolutely zero. "Get in
 * step with the team" then pulled a branch nobody else had touched, found
 * nothing, and reported "You are in step with the team" while the shared
 * branch had moved on without it.
 *
 * Which is worse than merely unhelpful: the panel went on to offer "ready
 * to finish" for a branch that had not seen the team's last week of work.
 *
 * Measured against the *server's* copy of the shared branch where there is
 * one, since that is what "the team" means; the local copy may itself be
 * stale.
 */
async function baseCatchUp() {
  const { status } = await gitService.getStatus();
  const branches = await branchService.resolveBranches();

  const current = status.detached ? null : status.current;
  const onShared = !!current &&
    (current === branches.base || current === branches.release);

  if (!current || onShared || !branches.base) {
    return { applicable: false, behind: 0, source: null, base: branches.base };
  }

  // origin/<base> when the server has it, because the point is to catch up
  // with the team rather than with this laptop's idea of the team.
  const source = await branchService.serverTip(branches.base);

  const behind = await releaseService.countBetween(current, source);

  return { applicable: true, behind, source, base: branches.base, current };
}

/**
 * Bring the shared branch into the current workstream.
 *
 * A merge rather than a rebase, for the reason stated everywhere else here:
 * rebasing rewrites save points that may already be on the server and in a
 * colleague's clone.
 */
async function catchUpWithBase() {
  const info = await baseCatchUp();

  if (!info.applicable || !info.behind) {
    return Object.assign({ merged: 0, conflicted: false }, info);
  }

  const result = await releaseService.mergeInto(
    info.current,
    info.source,
    `Bring ${info.base} into "${branchService.humanize(info.current)}"`
  );

  return Object.assign({ merged: info.behind }, info, { conflicted: result.conflicted });
}

/**
 * What changed on the server between two readings of its branch list.
 */
function driftBetween(before, after) {
  const appeared = [ ...after ].filter(name => !before.has(name));
  const removed = [ ...before ].filter(name => !after.has(name));

  return { appeared, removed };
}

async function runSync() {
  const plan = await planSync();

  if (!plan.possible) {
    throw new Error(plan.reason);
  }

  const done = [];

  // Local first, as every routine here does: after this the user's work is
  // a save point and nothing the network does can lose it.
  const autoSaved = await branchService.saveWorkInProgress();

  if (autoSaved) {
    done.push({ key: 'save', ok: true, label: `Saved ${autoSaved.saved} change(s)` });
  }

  const before = await branchService.listServerBranchNames();

  // pullCurrentBranch() already fetches with --prune and repairs a missing
  // or wrong upstream, so this is both the refresh and the update. Doing our
  // own fetch first would mean two round trips for one answer.
  let pulled;

  try {
    pulled = await branchService.pullCurrentBranch();
  } catch (err) {
    // Translated here rather than left as raw text.
    //
    // The bridge only translates errors that are *thrown*, and this one is
    // caught - so a sync that hit unrelated histories, or a rejected push,
    // reported git's own words in a step detail with no way to act on them.
    // Every one of those conditions has a fix attached to it; swallowing the
    // error swallowed the fix along with it.
    const friendly = gitErrors.translate(err);

    done.push({
      key: 'update',
      ok: false,
      label: "Could not get the team's updates",
      detail: friendly.detail || friendly.title
    });

    return {
      ok: false,
      routine: 'sync',
      steps: done,

      // Surfaced in the shape the panel already renders, so the offered
      // remedy appears here exactly as it would anywhere else.
      error: friendly.title,
      errorDetail: friendly.detail,
      fix: friendly.fix,
      raw: friendly.raw,
      recognised: friendly.recognised,

      summary:
        'Nothing was sent, because getting the team\'s updates has to work ' +
        'first. Your own work is saved and untouched.'
    };
  }

  const after = await branchService.listServerBranchNames();
  const drift = driftBetween(before, after);

  done.push({
    key: 'refresh',
    ok: true,
    label: describeDrift(drift)
  });

  // A conflict stops the routine here. Pushing a half-finished merge is not
  // possible anyway, and trying would replace a clear "choose a version"
  // with a second, confusing error.
  if (pulled.conflicted) {
    done.push({
      key: 'update',
      ok: false,
      label: 'Some diagrams need a decision before going further'
    });

    return {
      ok: true,
      routine: 'sync',
      needsDecision: true,
      drift,
      steps: done,
      summary:
        'You and the team both changed the same diagrams. Choose which ' +
        'version to keep, finish up, then get in step again - nothing is lost.'
    };
  }

  done.push({
    key: 'update',
    ok: true,
    label: pulled.nothingToGet
      ? 'Nothing to get - this workstream is not on the server yet'
      : "Got the team's updates"
  });

  // --- catch up with the shared branch ---------------------------------
  //
  // Runs after the branch's own pull and before the push, so anything
  // brought in from the shared branch is sent along with the rest rather
  // than sitting here until the next time.

  const caught = await catchUpWithBase();

  if (caught.conflicted) {
    done.push({
      key: 'catch-up',
      ok: false,
      label: `Bringing "${caught.base}" in needs a decision`
    });

    return {
      ok: true,
      routine: 'sync',
      needsDecision: true,
      drift,
      steps: done,
      summary:
        `The team's changes to "${caught.base}" touch the same diagrams as ` +
        'your work. Choose which version to keep, finish up, then get in ' +
        'step again - nothing is lost.'
    };
  }

  if (caught.merged) {
    done.push({
      key: 'catch-up',
      ok: true,
      label: `Brought ${caught.merged} change(s) from "${caught.base}" into your workstream`
    });
  }

  // Recomputed rather than reused: the pull and the catch-up both moved the
  // branch, so the ahead count from planSync() describes a state that no
  // longer exists.
  const { status } = await gitService.getStatus();

  if (!status.ahead && status.tracking) {
    done.push({ key: 'send', ok: true, label: 'Nothing of yours to send' });

    return {
      ok: true,
      routine: 'sync',
      drift,
      caughtUp: caught.merged,
      steps: done,
      summary: summarise(drift, inStepText(caught))
    };
  }

  try {
    const push = await branchService.publishCurrentBranch();

    done.push({
      key: 'send',
      ok: true,
      label: push.repaired
        ? 'Sent your work, and pointed this workstream at its own place on the server'
        : 'Sent your work to the team'
    });
  } catch (err) {
    done.push({
      key: 'send',
      ok: false,
      label: 'Could not send your work',
      detail: err.message
    });

    return {
      ok: true,
      partial: true,
      routine: 'sync',
      drift,
      steps: done,
      summary:
        'You have the team\'s updates, but yours could not be sent. Nothing ' +
        'is lost - it is all saved here. Try again when you are back online.'
    };
  }

  return {
    ok: true,
    routine: 'sync',
    drift,
    caughtUp: caught.merged,
    steps: done,
    summary: summarise(drift, inStepText(caught))
  };
}

/**
 * "In step" has to mean in step with the *shared branch*, not just with this
 * branch's own copy on the server.
 *
 * The original wording claimed the former while only ever checking the
 * latter, which is precisely the reassurance somebody acts on before
 * finishing a workstream that has not seen the team's last week of work.
 */
function inStepText(caught) {
  if (caught && caught.merged) {
    return `You are in step with the team, including the ${caught.merged} ` +
      `change(s) that were on "${caught.base}".`;
  }

  return 'You are in step with the team.';
}

function describeDrift({ appeared, removed }) {
  const parts = [];

  if (appeared.length) {
    parts.push(`${appeared.length} new on the server`);
  }

  if (removed.length) {
    parts.push(`${removed.length} no longer there`);
  }

  return parts.length
    ? `Checked the server: ${parts.join(', ')}`
    : 'Checked the server - the same workstreams as before';
}

/**
 * Drift is worth a sentence in the summary, not just a step label: a
 * workstream disappearing from the server is the thing somebody will
 * otherwise notice an hour later and not understand.
 */
function summarise({ appeared, removed }, base) {
  const extra = [];

  if (removed.length) {
    extra.push(
      `${removed.length} workstream(s) that were on the server have been ` +
      'removed there - normally because they were finished. Your own copies ' +
      'are untouched.'
    );
  }

  if (appeared.length) {
    extra.push(`${appeared.length} new workstream(s) from the team are now visible.`);
  }

  return [ base, ...extra ].join(' ');
}

// ---------------------------------------------------------------------
// "Put everything back to how it was"
// ---------------------------------------------------------------------

/**
 * Going back to an earlier save point, without erasing anything.
 *
 * The obvious implementation is `git reset --hard`, and it is the wrong one
 * here for two separate reasons. It throws away every save point after the
 * chosen one - on a workstream that has been sent, those save points are
 * also on the server and on colleagues' machines, so the only way to finish
 * the job is a force push, which overwrites their work. And it is
 * unrecoverable by the ordinary means this plugin offers: there is no
 * "actually, put it back" once the commits are unreferenced.
 *
 * So going back is done *forwards*. The working tree is set to the chosen
 * save point's exact contents and that becomes a **new** save point, whose
 * parent is where you were. Nothing is rewritten, nothing is unreachable,
 * sending works normally, and going back again - including back to where
 * you just were - is the same ordinary operation.
 *
 * `read-tree -u --reset` rather than a revert range because it is a
 * statement about the destination rather than about the path taken: it
 * restores deletions, additions and modifications alike, and it does not
 * fall over on a merge commit in the range the way `git revert` does
 * without being told which side to keep.
 */
async function resolveSavePoint(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) {
    throw new Error('Choose a save point to go back to first.');
  }

  const git = gitService.getGit();

  try {
    // `^{commit}` makes this reject a tag or a tree that happens to parse.
    const full = await git.raw([ 'rev-parse', '--verify', `${sha.trim()}^{commit}` ]);
    return full.trim();
  } catch (err) {
    throw new Error(
      'That save point is not in this project any more. Refresh the list and ' +
      'try again.'
    );
  }
}

async function planRollback(sha) {
  const target = await resolveSavePoint(sha);
  const git = gitService.getGit();
  const { branch, status } = await gitService.getStatus();

  if (conflictService.isMergeInProgress()) {
    return {
      routine: 'rollback',
      possible: false,
      reason:
        'Something is half-finished and needs sorting out first. Finish or ' +
        'cancel it, then come back here.'
    };
  }

  const head = gitService.readHeadSha();

  if (target === head) {
    return {
      routine: 'rollback',
      possible: false,
      reason: 'This is already how your diagrams are right now.'
    };
  }

  const [ described, changes ] = await Promise.all([
    git.raw([ 'log', '-1', '--format=%s%x09%an%x09%aI', target ]),
    git.raw([ 'diff', '--name-status', `${target}..HEAD` ])
  ]);

  const [ subject, author, date ] = described.trim().split('\t');

  const files = changes.split('\n').filter(Boolean).map(line => {
    const [ code, ...rest ] = line.split('\t');
    const path = rest.join('\t');

    // The diff is measured *from* the target *to* now, so its sense is
    // inverted for the reader: a file added since then is one that going
    // back removes.
    return {
      path,
      effect: code.startsWith('A') ? 'removed'
        : code.startsWith('D') ? 'restored' : 'changed'
    };
  });

  const steps = [];

  if (status.files.length) {
    steps.push({
      key: 'save',
      label: `Save your ${status.files.length} unsaved ` +
        `${status.files.length === 1 ? 'change' : 'changes'} first, so they are not lost`
    });
  }

  steps.push({
    key: 'restore',
    label: `Put your ${files.length} ${files.length === 1 ? 'file' : 'files'} back to how ` +
      `they were at "${subject}"`
  });

  steps.push({
    key: 'commit',
    label: 'Record that as a new save point'
  });

  const warnings = [
    'Nothing is deleted. This adds a new save point that undoes the changes, ' +
    'so everything in between stays in the history and you can come back ' +
    'here the same way.'
  ];

  if (status.ahead || (status.tracking && !status.behind)) {
    warnings.push(
      'This stays on your computer until you send it, like any other save point.'
    );
  }

  return {
    routine: 'rollback',
    possible: true,
    branch,
    target,
    short: target.slice(0, 7),
    subject,
    author,
    date,
    fileCount: files.length,
    files: files.slice(0, 50),
    truncated: files.length > 50,
    steps,
    warnings
  };
}

async function runRollback(sha) {
  const plan = await planRollback(sha);

  if (!plan.possible) {
    throw new Error(plan.reason);
  }

  const git = gitService.getGit();
  const done = [];

  // Unconditionally first: `read-tree -u --reset` overwrites the working
  // tree, so anything unsaved has to be a save point before it runs. This is
  // the one step that makes the whole routine non-destructive.
  const autoSaved = await branchService.saveWorkInProgress();

  if (autoSaved) {
    done.push({
      key: 'save',
      ok: true,
      label: `Saved ${autoSaved.saved} change(s) first`
    });
  }

  await git.raw([ 'read-tree', '-u', '--reset', plan.target ]);
  done.push({
    key: 'restore',
    ok: true,
    label: `Put ${plan.fileCount} file(s) back to how they were`
  });

  const config = configStore.readConfig();
  const { ticket } = naming.parse(plan.branch, config);
  const message = naming.applyTicketToMessage(
    `Went back to "${plan.subject}" (${plan.short})`,
    ticket
  );

  const commit = await gitService.commitStaged(message);

  done.push({
    key: 'commit',
    ok: true,
    label: 'Recorded it as a new save point',
    detail: commit.commit || ''
  });

  return {
    ok: true,
    routine: 'rollback',
    wentBackTo: plan.target,
    steps: done,
    summary:
      `Your diagrams are back to how they were at "${plan.subject}". ` +
      'Everything since then is still in the history - nothing was deleted.'
  };
}

/**
 * Fixes offered alongside a translated error.
 *
 * Each one is safe by construction: it either creates a save point (which
 * only ever adds history) or starts a merge (which "Start over" can
 * abort). None discards, resets, or force-pushes.
 */
/**
 * Every fix that pulls can end in a conflict, and a conflict is the
 * resolver's job, not an error. Reporting it as a failure here would tell
 * someone their fix did not work at the exact moment it did.
 */
async function pullReportingConflicts(run, successText) {
  try {
    await run();
    return successText;
  } catch (err) {
    if (!conflictService.isMergeInProgress()) {
      throw err;
    }

    return 'You and the team both changed the same diagrams. Nothing is lost - ' +
      'choose which version to keep below, then finish up.';
  }
}

/**
 * Pull from the server with an explicit refspec, never a bare `git pull`.
 *
 * Every fix here used the bare form, and every one of them was broken in
 * the same way for the same reason: `git pull` with no arguments requires an
 * upstream, and the situations these fixes exist for are disproportionately
 * the ones where there is not one yet.
 *
 * Unrelated histories is the clearest case - it happens precisely when a
 * project was started locally *and* on the server, so the local branch has
 * never tracked anything. Clicking "Combine them anyway" therefore failed
 * with "there is no tracking information for the current branch": a
 * different error, about a different problem, at the exact moment the user
 * had been promised this button would sort it out. A fix that cannot run in
 * its own trigger condition is worse than no fix, because the offer itself
 * is what earns the trust.
 *
 * Resolving the branch is the other half. The two sides need not agree on a
 * name: a folder init'd locally is often on `master` while the server's is
 * `main`, so falling back to the project's base branch is what makes this
 * work for the case it is named after.
 */
async function pullFromServer({ extra = [], success }) {
  const git = gitService.getGit();
  const { status } = await gitService.getStatus();
  const current = branchService.assertOnBranch(status, 'combine');

  if (!(await gitService.getRemoteUrl('origin'))) {
    throw new Error(
      'This project has no team server, so there is nothing to get.'
    );
  }

  await git.fetch([ 'origin', '--prune' ]);

  let source = null;

  if (await branchService.remoteBranchExists(current)) {
    source = current;
  } else {
    const { base } = await branchService.resolveBranches();

    if (base && await branchService.remoteBranchExists(base)) {
      source = base;
    }
  }

  if (!source) {
    throw new Error(
      'There is nothing on the team server under this name yet. Send your ' +
      'work first, and it becomes the starting point.'
    );
  }

  const message = await pullReportingConflicts(
    () => git.raw([ 'pull', ...extra, '--no-rebase', 'origin', source ]),
    success
  );

  // Record the link, so this never has to be explained twice.
  if (!conflictService.isMergeInProgress()) {
    try {
      await git.raw([ 'branch', `--set-upstream-to=origin/${source}`, current ]);
    } catch (err) {
      // Not worth failing a correct merge over.
    }
  }

  return message;
}

const FIXES = {

  /**
   * Two histories that never shared a starting point. Git refuses by
   * default because it is usually a mistake - but when the team really did
   * create the project on both sides, joining them is what is wanted.
   */
  'allow-unrelated': async () =>
    pullFromServer({
      extra: [ '--allow-unrelated-histories' ],
      success:
        `Your work and the team's are now one project. Everything from both ` +
        'sides is here - nothing was replaced.'
    }),

  /**
   * Both sides have commits the other lacks. Merge rather than rebase:
   * rebase rewrites history, which is far harder to reason about and to
   * undo when it goes wrong.
   */
  'merge-divergent': async () =>
    pullFromServer({ success: 'Everyone\'s changes are now combined.' }),

  /**
   * Uncommitted work blocking a pull. Save it first - never stash, which
   * hides the work somewhere the user will never find it again.
   */
  /**
   * A workstream tracking a different branch than its own - normally the
   * shared branch it was started from, inherited from git's
   * `branch.autoSetupMerge` default.
   *
   * Safe by construction: it publishes the current branch under its own
   * name and repoints the upstream marker at it. Nothing is overwritten,
   * and the branch it was mistakenly tracking is left alone.
   */
  'realign-upstream': async () => branchService.realignUpstream(),

  /**
   * Detached HEAD. Safe by construction: it commits before it moves, and
   * creates a branch for work that is not already on one. Nothing is
   * discarded, reset, or force-anything.
   */
  'return-to-workstream': async () => branchService.rescueDetachedHead(),

  /**
   * A branch with no upstream at all - normally one that was pushed without
   * `-u`, or has never been sent.
   *
   * Safe: it only reads what the server has and, if there is a matching
   * branch, pulls from it and records the link. When there is nothing to
   * link to it reports that and changes nothing.
   */
  'link-to-server': async () => {
    const result = await branchService.pullCurrentBranch();

    if (result.summary) {
      return result.summary;
    }

    return result.linked
      ? `Linked up with the server, and the team's updates are downloaded.`
      : 'The team\'s updates are downloaded.';
  },

  /**
   * The server's branch list, refreshed.
   *
   * Git only ever *adds* remote-tracking refs on a fetch, so a branch
   * deleted on the server keeps appearing here long after it is gone -
   * and anything that acts on it fails with an error about a branch the
   * panel is still showing.
   *
   * Safe by construction: `--prune` only removes the local record of what
   * the server has. No local workstream, save point or file is touched.
   */
  'refresh-server-list': async () => {
    const git = gitService.getGit();

    await git.fetch([ 'origin', '--prune' ]);

    return 'The list of what is on the team server is up to date again. ' +
      'Anything removed there is no longer offered here.';
  },

  'save-then-pull': async () => {
    const { status } = await gitService.getStatus();

    if (status.files.length) {
      await gitService.stageAll();
      await gitService.commitStaged('Work in progress');
    }

    return pullFromServer({
      success: 'Your work was saved, and the team\'s updates are downloaded.'
    });
  }
};

async function applyFix(id) {
  const fix = FIXES[id];

  if (!fix) {
    throw new Error(`Unknown fix "${id}".`);
  }

  return fix();
}

module.exports = {
  planSaveMyWork,
  runSaveMyWork,
  planFinish,
  runFinish,
  finishRouteFor,
  planSync,
  runSync,
  planRollback,
  runRollback,
  getMergePolicy,
  applyFix,
  FIXES
};
