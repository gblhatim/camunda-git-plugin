/**
 * "What should I do now?", answered once, in one place.
 *
 * The "My work" tab used to offer everything it could do at all times:
 * switch workstream, start one, save, finish, go back to an earlier version.
 * Six blocks of equal weight, in a panel that is wide and short, most of
 * them not actionable at any given moment. "Finish this workstream" sitting
 * at full prominence when there is nothing to finish is not a neutral cost -
 * it is the reader having to rule out five things to find the one that
 * applies.
 *
 * The plugin already had the right idea and only applied it to emergencies:
 * setup takes over the whole tab, a conflict takes over the whole tab, and
 * both work well because there is exactly one thing to do. This generalises
 * that to ordinary operation.
 *
 * It lives in the main process, next to the services whose state it reads,
 * for the same reason `listWorkstreams()` returns the naming rules rather
 * than letting the renderer restate them: a second copy of "when can you
 * finish?" in the UI is a copy that will disagree with the routine that
 * actually decides.
 *
 * This module is **advisory and read-only**. It runs no git command that
 * changes anything, and nothing here gates an action - every routine keeps
 * its own preconditions and its own preview. Being wrong about what to lead
 * with costs a click; it can never cost work.
 */

'use strict';

const gitService = require('./git-service');
const branchService = require('./branch-service');
const conflictService = require('./conflict-service');
const configStore = require('./config-store');
const routines = require('./routines');

/**
 * How many save points this workstream has that the shared branch does not.
 *
 * This is what separates "a branch you made and have not used" from "work
 * worth finishing", and it is the only reason `finish` is ever the lead.
 *
 * Returns 0 rather than throwing on every ordinary failure: an unborn HEAD,
 * a base branch that does not exist locally, a fresh clone that has not
 * fetched. A wrong-but-quiet 0 demotes `finish` to a secondary action, which
 * is the safe direction to be wrong in.
 */
async function countAheadOfBase(base, current) {
  if (!base || !current || base === current) {
    return 0;
  }

  try {
    const git = gitService.getGit();
    const raw = await git.raw([ 'rev-list', '--count', `${base}..${current}` ]);

    return Number(raw.trim()) || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * The actions this tab can offer, in the order they take precedence.
 *
 * The order encodes the plugin's existing invariant rather than a taste
 * call: local work is made safe before anything touches the network, and
 * the network is brought up to date before anything is sent. So an unsaved
 * change outranks being behind, and being behind outranks being ahead -
 * which is also the order in which git will otherwise refuse.
 */
const ACTIONS = {
  resolve: {
    id: 'resolve',
    title: 'Some diagrams need a decision',
    cta: 'Sort it out',
    tone: 'urgent'
  },
  detached: {
    id: 'detached',
    title: 'You are looking at an old version',
    cta: 'Put me back on a workstream',
    tone: 'urgent'
  },
  save: {
    id: 'save',
    title: 'You have unsaved changes',
    cta: 'Save my work',
    tone: 'action'
  },
  update: {
    id: 'update',
    title: 'The team has changes you do not have',
    cta: 'Get updates',
    tone: 'action'
  },
  sync: {
    id: 'sync',
    title: 'You and the team have both moved on',
    cta: 'Get in step with the team',
    tone: 'action'
  },
  send: {
    id: 'send',
    title: 'Your work is only on this computer',
    cta: 'Send to the team',
    tone: 'action'
  },
  finish: {
    id: 'finish',
    title: 'This workstream is ready to finish',
    cta: "I'm finished with this",
    tone: 'action'
  },
  tidy: {
    id: 'tidy',
    title: 'This workstream has been merged',
    cta: 'Tidy it up',
    tone: 'calm'
  },
  start: {
    id: 'start',
    title: 'Start something new',
    cta: 'Start a workstream',
    tone: 'calm'
  },
  idle: {
    id: 'idle',
    title: 'Everything is saved and up to date',
    cta: null,
    tone: 'calm'
  }
};

/**
 * Resolve the single thing worth leading with, plus everything else that is
 * currently possible so the panel can list them quietly underneath.
 */
async function get() {
  const { status } = await gitService.getStatus();
  const config = configStore.readConfig();

  const branches = await branchService.resolveBranches();
  const current = status.detached ? null : status.current;
  const onShared = !!current && (current === branches.base || current === branches.release);

  const changed = status.files.length;
  const ahead = status.ahead || 0;
  const behind = status.behind || 0;

  const hasRemote = !!(await gitService.getRemoteUrl('origin'));

  // Both counts are measured against the server's copy of the shared
  // branch - see branchService.serverTip(). Against a stale local `develop`
  // they disagree in opposite and equally misleading directions: `unmerged`
  // counts work as outstanding that the team already has, and `behindBase`
  // reports nothing to catch up on.
  const shared = await branchService.serverTip(branches.base);

  const counted = onShared ? 0 : await countAheadOfBase(shared, current);

  // A commit count is the wrong instrument once the branch has been merged
  // by squash or rebase: the work is on the shared branch but the commits
  // that carried it are not, so the count stays above zero forever and the
  // panel goes on offering "ready to finish" for something that shipped
  // last week. Under this plugin's default review policy - where merging
  // happens through a pull request, and "squash and merge" is the button
  // most teams press - that is the normal ending for a workstream, not an
  // edge case.
  //
  // One containment check settles it. This runs on tab activation and when
  // the repository moves, not on the status poll, so the extra call is not
  // on the hot path.
  const alreadyMerged = counted > 0 && !onShared
    ? (await branchService.isContainedIn(shared, current)) === true
    : false;

  const unmerged = alreadyMerged ? 0 : counted;

  // The mirror of `unmerged`, and the one `status.behind` cannot see:
  // `behind` counts this branch against its own copy on the server, so it
  // stays zero however far the shared branch runs ahead. Without this the
  // panel offers "ready to finish" for a workstream that has not caught up.
  const behindBase = onShared || !current
    ? 0
    : await countAheadOfBase(current, shared);

  // Never sent is not the same as "nothing to send". A workstream created
  // and committed to but never pushed reports ahead: 0 with no upstream,
  // because there is no upstream to be ahead *of* - and the panel would
  // then say "up to date" about work that exists nowhere but this laptop.
  const neverSent = !!current && !status.tracking && unmerged > 0;

  const facts = {
    branch: current,
    title: current ? branchService.humanize(current) : null,
    onShared,
    base: branches.base,
    model: branches.model,
    changed,
    ahead,
    behind,
    unmerged,
    behindBase,
    alreadyMerged,
    neverSent,
    hasRemote,
    mergePolicy: routines.getMergePolicy(),
    detached: !!status.detached,
    merging: conflictService.isMergeInProgress()
  };

  const lead = chooseLead(facts);

  return {
    action: Object.assign({}, ACTIONS[lead.id], { detail: lead.detail }),
    also: available(facts, lead.id),
    facts
  };
}

/**
 * The precedence chain. Deliberately a flat sequence of ifs rather than a
 * scoring function: every branch here has to be explainable in one sentence
 * to somebody asking "why is it telling me to do that?".
 */
function chooseLead(f) {
  if (f.merging) {
    return {
      id: 'resolve',
      detail:
        'You and the team changed the same diagrams. Nothing is lost - ' +
        'choose which version to keep, then finish up.'
    };
  }

  if (f.detached) {
    return {
      id: 'detached',
      detail:
        'You are viewing a past state of the project rather than working on ' +
        'a workstream. Anything saved here would be hard to find again.'
    };
  }

  if (f.changed) {
    return {
      id: 'save',
      detail:
        `${f.changed} ${f.changed === 1 ? 'diagram has' : 'diagrams have'} ` +
        'changed since your last save point.' +
        (f.onShared
          ? ' You are on the shared version, so consider starting a ' +
            'workstream for this first.'
          : '')
    };
  }

  // Both directions have work: this is the case where doing it as two
  // separate button presses fails, because a send before a get is refused
  // as a non-fast-forward. The sync routine is the same two steps in the
  // order that works, so it leads rather than making somebody discover the
  // ordering from an error message.
  if (f.behind && (f.ahead || f.neverSent)) {
    return {
      id: 'sync',
      detail:
        `They have ${f.behind} change(s) you do not, and you have ` +
        `${f.ahead || f.unmerged} they do not. These have to be combined ` +
        'before anything can be sent - this does it in the right order.'
    };
  }

  // Before sending, on purpose: git refuses a push onto a branch that has
  // moved on, and telling somebody to send first only to have it rejected
  // is the sequence this whole tab exists to avoid.
  if (f.behind) {
    return {
      id: 'update',
      detail:
        `${f.behind} ${f.behind === 1 ? 'change' : 'changes'} from the team ` +
        'to download. Your own work is untouched by this.'
    };
  }

  if (f.ahead || f.neverSent) {
    const count = f.ahead || f.unmerged;

    return {
      id: 'send',
      detail: f.neverSent
        ? `This workstream has ${count} save point(s) and has never been sent. ` +
          'Until it is, it exists only here.'
        : `${count} save point(s) are not on the team server yet.`
    };
  }

  // Before `finish`, deliberately. Finishing a workstream that has not seen
  // the shared branch's latest work is how a small merge becomes a large
  // one, and it is the state this panel used to describe as "ready".
  if (f.behindBase > 0) {
    return {
      id: 'sync',
      detail:
        `The team has made ${f.behindBase} change(s) to "${f.base}" since ` +
        'this workstream started. Bringing them in now keeps finishing ' +
        'later small.'
    };
  }

  if (!f.onShared && f.unmerged > 0) {
    return {
      id: 'finish',
      detail: f.mergePolicy === 'review'
        ? 'Everything is saved and sent. Finishing opens a review request so ' +
          'someone can check it before it reaches the shared version.'
        : 'Everything is saved and sent. Finishing combines it into the ' +
          'shared version.'
    };
  }

  // The work landed, but through a route that rewrote the save points, so
  // nothing else here can tell. Saying so is what closes the loop: without
  // it the branch sits in the list forever looking like unfinished work.
  if (f.alreadyMerged) {
    return {
      id: 'tidy',
      detail:
        `Everything from "${f.title}" is already in "${f.base}" - it was ` +
        'combined in a way that rewrote the save points, which is what a ' +
        'review approved with "squash" does. You can remove it and start ' +
        'something new.'
    };
  }

  if (f.onShared) {
    return {
      id: 'start',
      detail:
        'You are on the shared version and everything is up to date. Work ' +
        'usually starts by making a workstream for it.'
    };
  }

  return {
    id: 'idle',
    detail: f.hasRemote
      ? 'Nothing to save, nothing to send, nothing waiting from the team.'
      : 'Nothing to save. This project has no team server, so everything ' +
        'stays on this computer.'
  };
}

/**
 * What else is possible right now.
 *
 * Not "every button that exists" - the point of the lead is lost if the list
 * underneath it is the old six blocks with a hat on. These are the ones that
 * are genuinely actionable, so the panel can show them as one-line rows and
 * keep the rest collapsed.
 */
function available(f, leadId) {

  // Half-finished operations and detached HEAD are not "the lead action,
  // plus the usual options" - they are states in which the usual options are
  // the wrong thing to do. Saving mid-merge is how somebody gets truly
  // stuck, and every one of these would either fail outright or bury the
  // problem deeper. There is one way out and it is the lead.
  if (f.merging || f.detached) {
    return [];
  }

  const rows = [];

  const add = (id, label) => {
    if (id !== leadId) rows.push({ id, label });
  };

  if (f.changed) add('save', 'Save my work');
  if (f.behind) add('update', `Get updates (${f.behind})`);
  if (f.ahead) add('send', `Send (${f.ahead})`);

  // Always available where there is a server: it is the "just put me back in
  // step, I do not want to think about which half is out of date" option,
  // and needing it is not always something the counts predict - a stale
  // branch list shows neither ahead nor behind.
  if (f.hasRemote) add('sync', 'Get in step with the team');
  if (!f.onShared && f.unmerged > 0) add('finish', 'Finish this workstream');
  if (f.alreadyMerged) add('tidy', 'Remove this merged workstream');
  add('start', 'Start a new workstream');

  return rows;
}

module.exports = { get, chooseLead, available, countAheadOfBase, ACTIONS };
