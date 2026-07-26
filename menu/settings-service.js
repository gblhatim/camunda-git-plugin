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

const DEFAULTS = {
  repoPath: '',
  gitlabHost: 'gitlab.com',
  mergePolicy: 'review',

  // The OpenRouter model used for AI edits. A safe, widely-available
  // default; changeable in Settings, since OpenRouter's ids move over time.
  openRouterModel: 'anthropic/claude-3.5-sonnet',

  // Off by default. It turns the Activity tab into a git console, which is
  // wanted by developers and is a way for an analyst to destroy a week of
  // work by pasting something from a search result.
  developerMode: false,

  autoPull: {
    enabled: false,
    intervalMinutes: 15
  }
};

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

    autoPull: {
      enabled: !!autoPull.enabled,
      intervalMinutes: clampInterval(autoPull.intervalMinutes)
    },

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

  return read();
}

module.exports = {
  read,
  update,
  clampInterval,
  DEFAULTS,
  MIN_INTERVAL,
  MAX_INTERVAL
};
