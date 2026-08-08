/**
 * The plugin's settings, as a single shape the Settings tab can render and
 * write back.
 *
 * Previously these lived in a chain of modal prompts behind a menu item,
 * which meant changing one thing required clicking through all of them.
 *
 * Tokens are handled write-only: they are never sent to the renderer, only
 * a flag saying whether one is set. They still sit in plaintext in
 * ~/.camunda-git-plugin/config.json, so this is not real secrecy - it just
 * keeps them out of the HTTP responses and off the screen.
 */

'use strict';

const configStore = require('./config-store');
const tabAccess = require('./tab-access');

const DEFAULTS = {
  repoPath: '',
  gitlabHost: 'gitlab.com',
  mergePolicy: 'review',

  // The OpenRouter model used for AI edits. A safe, widely-available
  // default; changeable in Settings, since OpenRouter's ids move over time.
  openRouterModel: 'anthropic/claude-sonnet-4.5',

  // The panel's language. English by default rather than guessed from the
  // system locale: a wrong guess is worse than a plain default here, because
  // the person who needs French can set it in one click and the person who
  // does not has nothing to undo.
  language: 'en',

  // Off by default. It turns the Activity tab into a git console, which is
  // wanted by developers and is a way for an analyst to destroy a week of
  // work by pasting something from a search result.
  developerMode: false,

  autoPull: {
    enabled: false,
    intervalMinutes: 15
  }
};

// Kept in step with client/i18n.js by hand: the renderer is bundled
// separately and cannot require this file. An id here with no dictionary in
// the panel falls back to English rather than breaking, which is the safe
// direction for the two to drift in.
const LANGUAGES = [ 'en', 'fr' ];

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 240;

function read() {
  const config = configStore.readConfig();
  const autoPull = config.autoPull || {};

  return {
    repoPath: config.repoPath || DEFAULTS.repoPath,
    gitlabHost: config.gitlabHost || DEFAULTS.gitlabHost,
    mergePolicy: config.mergePolicy === 'direct' ? 'direct' : 'review',
    developerMode: !!config.developerMode,
    language: LANGUAGES.includes(config.language) ? config.language : DEFAULTS.language,
    languages: LANGUAGES,

    autoPull: {
      enabled: !!autoPull.enabled,
      intervalMinutes: clampInterval(autoPull.intervalMinutes)
    },

    // Which areas this project shows, and whether this person may change
    // the set. The list of what *could* be shown travels with it so the
    // Settings tab does not have to keep its own copy in sync.
    enabledTabs: tabAccess.normalize(config.enabledTabs),
    allTabs: tabAccess.TABS,
    alwaysOnTabs: tabAccess.ALWAYS_ON,
    canEditTabs: !!config.developerMode,

    // Presence only - never the value.
    hasGithubToken: !!config.githubToken,
    hasGitlabToken: !!config.gitlabToken,

    // The AI edit model is not a secret; the key is (presence only).
    openRouterModel: config.openRouterModel || DEFAULTS.openRouterModel,
    hasOpenRouterKey: !!config.openRouterKey
  };
}

function clampInterval(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return DEFAULTS.autoPull.intervalMinutes;
  }

  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
}

/**
 * Apply a partial update. Only known keys are written, so a malformed
 * request cannot inject arbitrary config.
 */
function update(patch = {}) {
  const current = configStore.readConfig();
  const next = {};

  if (typeof patch.repoPath === 'string' && patch.repoPath) {
    next.repoPath = patch.repoPath;
  }

  if (typeof patch.gitlabHost === 'string') {
    next.gitlabHost = patch.gitlabHost.trim() || DEFAULTS.gitlabHost;
  }

  if (patch.mergePolicy === 'direct' || patch.mergePolicy === 'review') {
    next.mergePolicy = patch.mergePolicy;
  }

  // An unknown id is dropped rather than stored: a config file naming a
  // language the panel has no dictionary for would render English anyway,
  // and saving it would make the dropdown show a value it cannot honour.
  if (LANGUAGES.includes(patch.language)) {
    next.language = patch.language;
  }

  if (patch.developerMode !== undefined) {
    next.developerMode = !!patch.developerMode;
  }

  if (patch.autoPull && typeof patch.autoPull === 'object') {
    next.autoPull = {
      enabled: !!patch.autoPull.enabled,
      intervalMinutes: clampInterval(
        patch.autoPull.intervalMinutes !== undefined
          ? patch.autoPull.intervalMinutes
          : (current.autoPull || {}).intervalMinutes
      )
    };
  }

  // Tokens: an empty string clears, undefined leaves alone. This is the
  // only way to remove one without editing the file by hand.
  if (typeof patch.githubToken === 'string') {
    next.githubToken = patch.githubToken;
  }
  if (typeof patch.gitlabToken === 'string') {
    next.gitlabToken = patch.gitlabToken;
  }

  // Same write-only rule as the tokens: an empty string clears the key.
  if (typeof patch.openRouterKey === 'string') {
    next.openRouterKey = patch.openRouterKey;
  }
  if (typeof patch.openRouterModel === 'string') {
    next.openRouterModel = patch.openRouterModel.trim() || DEFAULTS.openRouterModel;
  }

  configStore.update(next);

  // The visible areas are the project's, not the machine's, so they go
  // straight into the committed file rather than the local store - written
  // last, so a rejected patch above cannot leave a half-applied pair.
  //
  // Refused rather than ignored when developerMode is off: silently
  // dropping a write the UI offered is how a setting appears to save and
  // then come back wrong on the next read.
  if (patch.enabledTabs !== undefined) {
    // The patch may be turning developer mode on in the same request, and
    // that counts - the gate is on the state being saved, not the one being
    // replaced.
    const allowed = next.developerMode !== undefined
      ? next.developerMode
      : !!current.developerMode;

    if (!allowed) {
      throw new Error(
        'Changing which areas this project shows needs developer mode, ' +
        'which is off. Turn it on in Settings first.'
      );
    }

    const repoPath = configStore.readRaw().global.repoPath;

    if (!repoPath) {
      throw new Error('No project folder is selected, so there is nowhere to save this.');
    }

    configStore.writeShared(repoPath, {
      enabledTabs: tabAccess.normalize(patch.enabledTabs)
    });
  }

  return read();
}

module.exports = {
  read,
  update,
  clampInterval,
  LANGUAGES,
  DEFAULTS,
  MIN_INTERVAL,
  MAX_INTERVAL
};
