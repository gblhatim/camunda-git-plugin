/**
 * Writing the team's settings into the repository.
 *
 * `.camunda-git.json` is the file that makes analysts and developers agree
 * on where work starts and where it goes back to. Until it exists, every
 * clone falls back to guessing from branch names, and two people can guess
 * differently without either of them finding out until a merge.
 *
 * It is never written automatically. Writing to someone's working tree as a
 * side effect of opening a panel would dirty a clean checkout at startup
 * and put a file in their next commit that they did not create - so this is
 * always an explicit action, and it reports the plan before doing anything.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gitService = require('./git-service');
const configStore = require('./config-store');
const branchService = require('./branch-service');
const naming = require('./naming');

const MODELS = {
  trunk: {
    id: 'trunk',
    label: 'One shared version',
    hint:
      'Everyone works from a single shared branch and returns to it. ' +
      'Simplest, and enough for most teams.'
  },
  gitflow: {
    id: 'gitflow',
    label: 'Separate released version (Gitflow)',
    hint:
      'Day-to-day work collects on one branch; a second branch holds what ' +
      'is actually live. Urgent fixes start from the live one.'
  }
};

/**
 * What is set up now, what could be, and what the repository actually
 * contains - enough for the form to be filled in rather than blank.
 */
async function inspect() {
  const repoPath = gitService.getRepoPath();
  const file = path.join(repoPath, configStore.SHARED_FILENAME);
  const exists = fs.existsSync(file);

  const shared = configStore.readShared(repoPath);
  const branches = await branchService.resolveBranches();
  const known = [ ...(await branchService.listKnownBranchNames()) ].sort();
  const config = configStore.readConfig();

  return {
    exists,
    file: configStore.SHARED_FILENAME,
    committed: exists ? await isCommitted(configStore.SHARED_FILENAME) : false,
    models: Object.keys(MODELS).map(id => MODELS[id]),
    branches: known,

    // What the panel should show in the form: the committed values if there
    // are any, otherwise whatever is currently being guessed - so accepting
    // the defaults writes down the behaviour the team already has.
    current: {
      branchModel: shared.branchModel || branches.model,
      baseBranch: shared.baseBranch || branches.base,
      releaseBranch: shared.releaseBranch || branches.release,
      mergePolicy: shared.mergePolicy || config.mergePolicy || 'review',
      jiraHost: shared.jiraHost || '',
      jiraProjectKey: shared.jiraProjectKey || naming.DEFAULT_PROJECT_KEY
    },

    guessing: !branches.configured,
    warning: branches.warning
  };
}

/**
 * Is the settings file already part of the repository, or only sitting in
 * the working tree? An uncommitted one helps nobody else.
 */
async function isCommitted(relPath) {
  const git = gitService.getGit();

  try {
    const tracked = await git.raw([ 'ls-files', '--error-unmatch', relPath ]);
    return !!tracked.trim();
  } catch (err) {
    return false;
  }
}

function validate(settings, knownBranches) {
  const model = settings.branchModel === 'gitflow' ? 'gitflow' : 'trunk';

  const base = String(settings.baseBranch || '').trim();
  const release = String(
    model === 'gitflow' ? (settings.releaseBranch || '') : base
  ).trim();

  if (!base) {
    throw new Error('Choose the branch that everyday work starts from.');
  }

  if (model === 'gitflow' && !release) {
    throw new Error('Choose the branch that holds what is live.');
  }

  if (model === 'gitflow' && base === release) {
    throw new Error(
      'The everyday branch and the live branch have to be different - ' +
      'otherwise there is only one shared version, which is the simpler ' +
      'setup above.'
    );
  }

  // A committed file naming a branch nobody has is worse than no file: it
  // makes every clone show a warning, including the ones that were working.
  [ base, release ].forEach(name => {
    if (name && !knownBranches.has(name)) {
      throw new Error(
        `There is no branch called "${name}" in this project. Create it ` +
        'first, or pick one from the list.'
      );
    }
  });

  const key = String(settings.jiraProjectKey || naming.DEFAULT_PROJECT_KEY)
    .trim()
    .toUpperCase();

  if (!/^[A-Z][A-Z0-9]*$/.test(key)) {
    throw new Error(`"${key}" is not a valid ticket prefix. Use letters, like BDM.`);
  }

  return {
    branchModel: model,
    baseBranch: base,
    releaseBranch: release,
    mergePolicy: settings.mergePolicy === 'direct' ? 'direct' : 'review',
    jiraHost: String(settings.jiraHost || '').trim(),
    jiraProjectKey: key
  };
}

/**
 * Describe what saving would do, without doing it - the same contract every
 * routine in this plugin follows.
 */
async function plan(settings) {
  const known = await branchService.listKnownBranchNames();
  const next = validate(settings, known);
  const before = await inspect();

  const steps = [ {
    key: 'write',
    label: before.exists
      ? `Update ${configStore.SHARED_FILENAME} in your project folder`
      : `Create ${configStore.SHARED_FILENAME} in your project folder`
  } ];

  const warnings = [
    'This adds a file to your project. It is not shared with the team until ' +
    'you save your work and send it, like any other change.'
  ];

  if (next.branchModel === 'gitflow') {
    warnings.push(
      `New work will start from "${next.baseBranch}" instead of wherever it ` +
      'does now, and urgent fixes will start from ' +
      `"${next.releaseBranch}".`
    );
  }

  // Named `projectSettings`, not `settings`: the personal settings routes
  // already use that key, and the panel adopts `settings` from any response
  // as the user's own. Colliding here replaced the personal settings object
  // with this one - which has no autoPull - and the Settings tab then blew
  // up dereferencing it.
  return { possible: true, steps, warnings, projectSettings: next, before };
}

/**
 * Write it. Deliberately does not stage or commit: putting a file in
 * someone's index without them asking is exactly the kind of surprise the
 * rest of the plugin works to avoid, and the Source Control panel will show
 * it as a normal change to save.
 */
async function apply(settings) {
  const known = await branchService.listKnownBranchNames();
  const next = validate(settings, known);
  const repoPath = gitService.getRepoPath();

  configStore.writeShared(repoPath, next);

  return {
    ok: true,
    projectSettings: next,
    file: configStore.SHARED_FILENAME,
    summary:
      `Project settings saved to ${configStore.SHARED_FILENAME}. Save your ` +
      'work and send it so the rest of the team gets them too.'
  };
}

module.exports = { MODELS, inspect, validate, plan, apply, isCommitted };
