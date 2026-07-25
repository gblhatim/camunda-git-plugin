/**
 * Background "get updates".
 *
 * Automatic git operations are a trust problem before they are a technical
 * one: something that changes a person's files while they are working, and
 * cannot be seen afterwards, will be blamed for everything. So this is
 * deliberately timid.
 *
 * It refuses to run unless *all* of these hold:
 *   - the user turned it on
 *   - there is a remote to pull from
 *   - the working tree is completely clean
 *   - no merge is half-finished
 *   - no other plugin operation is in flight
 *
 * A clean tree is the important one: pulling into uncommitted work is how
 * you get a surprise conflict in the middle of someone's editing session.
 * If there is anything unsaved, it simply waits for the next tick.
 *
 * Every command it runs is tagged `auto` in the command log, so the
 * Activity tab always shows what happened while nobody was looking.
 */

'use strict';

const gitService = require('./git-service');
const branchService = require('./branch-service');
const conflictService = require('./conflict-service');
const settingsService = require('./settings-service');
const commandLog = require('./command-log');

let timer = null;
let running = false;
let lastRun = null;
let lastResult = null;

// Set by bridge-server so a user action and an auto-pull never overlap.
let isBusy = () => false;

function setBusyCheck(fn) {
  isBusy = fn;
}

/**
 * Why an auto-pull would be skipped right now, or null if it can proceed.
 * Exposed so the Settings tab can explain itself rather than looking
 * broken when nothing happens.
 */
async function checkPreconditions() {
  const settings = settingsService.read();

  if (!settings.autoPull.enabled) {
    return 'turned off';
  }

  if (!settings.repoPath) {
    return 'no project folder selected';
  }

  if (isBusy()) {
    return 'another operation is running';
  }

  let status;

  try {
    ({ status } = await gitService.getStatus());
  } catch (err) {
    return 'the project folder is not readable';
  }

  if (conflictService.isMergeInProgress()) {
    return 'waiting - a merge needs finishing first';
  }

  if (status.files.length) {
    return 'waiting - you have unsaved changes';
  }

  if (!(await gitService.getRemoteUrl('origin'))) {
    return 'no team server configured';
  }

  return null;
}

/**
 * One attempt. Never throws: a failed background pull is a log entry, not
 * an interruption.
 */
async function tick() {
  if (running) {
    return { skipped: 'already running' };
  }

  running = true;

  try {
    const blocked = await checkPreconditions();

    if (blocked) {
      lastResult = { at: Date.now(), skipped: blocked };
      return lastResult;
    }

    const before = await gitService.getStatus();

    await commandLog.withOrigin('auto', async () => {
      // Same path the "Get updates" button takes, so a branch with no
      // upstream is a quiet no-op in the background rather than an error
      // that recurs every fifteen minutes.
      await branchService.pullCurrentBranch();
    });

    const after = await gitService.getStatus();

    // A conflict can still happen if the incoming change touches something
    // committed locally. The panel picks this up on its next poll and
    // switches to the resolver.
    const conflicted = conflictService.isMergeInProgress();

    lastRun = Date.now();
    lastResult = {
      at: lastRun,
      pulled: true,
      conflicted,
      behindBefore: before.status.behind,
      behindAfter: after.status.behind
    };

    return lastResult;
  } catch (err) {
    lastRun = Date.now();
    lastResult = { at: lastRun, error: err.message || String(err) };
    return lastResult;
  } finally {
    running = false;
  }
}

/**
 * (Re)start the timer from current settings. Safe to call repeatedly -
 * the Settings tab calls it after every save.
 */
function restart() {
  stop();

  const settings = settingsService.read();

  if (!settings.autoPull.enabled) {
    return { enabled: false };
  }

  const everyMs = settings.autoPull.intervalMinutes * 60 * 1000;

  timer = setInterval(() => { tick(); }, everyMs);

  // Do not fire immediately on start: Modeler is usually still opening,
  // and a surprise pull during startup is the worst first impression.
  return { enabled: true, intervalMinutes: settings.autoPull.intervalMinutes };
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function state() {
  return {
    active: !!timer,
    running,
    lastRun,
    lastResult
  };
}

module.exports = {
  restart,
  stop,
  tick,
  state,
  checkPreconditions,
  setBusyCheck
};
