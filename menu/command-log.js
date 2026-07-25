/**
 * A record of every git command the plugin runs.
 *
 * Two reasons this exists. First, trust: the plugin hides git behind
 * plain-language buttons, and anything that acts on someone's work without
 * showing what it did is asking to be distrusted the first time it
 * surprises them. Second, support: when a analyst says "it broke", the
 * developer needs the actual commands, not a paraphrase.
 *
 * The log records what a command *answered*, not just that it ran. An
 * auto-pull that reports "Already up to date" and one that merged four
 * commits are the same line without it, and the difference is usually the
 * thing being investigated.
 *
 * This module never runs anything itself - it observes. Commands typed into
 * the console are executed by git-console.js and recorded here through
 * `record()`, on the same footing as every automatic one.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// How the command was triggered. Async-local rather than a plain flag so a
// background auto-pull cannot mislabel a user action that overlaps it.
const originStore = new AsyncLocalStorage();

const MAX_ENTRIES = 300;

const entries = [];
let nextId = 1;

/**
 * Run `fn` with every git command inside it tagged with an origin
 * ("auto", "routine:save", ...). Nested calls keep the outermost tag.
 */
function withOrigin(origin, fn) {
  return originStore.run({ origin }, fn);
}

function currentOrigin() {
  const store = originStore.getStore();
  return (store && store.origin) || 'user';
}

/**
 * Render a simple-git call as the command line a developer would type.
 *
 * Long or multi-line arguments (commit messages, merge messages) are
 * truncated - the log is for scanning, and the full message is visible in
 * the history anyway.
 */
function formatCommand(method, args) {
  const flat = [];

  const push = value => {
    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }

    // Options objects and flag arguments (getRemotes(true)) are call
    // details, not part of the command line.
    if (typeof value === 'object' || typeof value === 'boolean') return;

    const text = String(value);
    const oneLine = text.split('\n')[0];
    const clipped = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;

    flat.push(/\s/.test(clipped) ? `"${clipped}"` : clipped);
  };

  args.forEach(push);

  // `raw` already carries the subcommand; the others are named after it.
  const verb = method === 'raw' ? '' : methodToVerb(method);

  return `git ${[ verb, ...flat ].filter(Boolean).join(' ')}`.trim();
}

const VERBS = {
  add: 'add',
  commit: 'commit -m',
  push: 'push',
  pull: 'pull',
  fetch: 'fetch',
  checkout: 'checkout',
  checkoutLocalBranch: 'checkout -b',
  status: 'status',
  diff: 'diff',
  show: 'show',
  log: 'log',
  rm: 'rm',
  reset: 'reset',
  revparse: 'rev-parse',
  branchLocal: 'branch',
  deleteLocalBranch: 'branch -d',
  getRemotes: 'remote -v',
  addRemote: 'remote add',
  subModule: 'submodule'
};

/**
 * simple-git names its methods in camelCase; git's own subcommands are
 * lower-case and hyphenated. Without translation the log shows
 * `git revparse HEAD` - a command that does not exist, in the one tab whose
 * purpose is to show exactly what ran, and which a developer may well try
 * to copy into a terminal.
 *
 * The table above covers the ones with a genuinely different shape
 * (`branchLocal` -> `branch`); anything else falls back to hyphenating,
 * which is the right answer for the rest of simple-git's surface.
 */
function methodToVerb(method) {
  return VERBS[method] ||
    method.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Per-entry cap. The log holds MAX_ENTRIES of these in memory and ships
// them over the bridge as JSON, so a `git log` with no limit must not be
// able to make the panel unresponsive.
const MAX_OUTPUT_CHARS = 20000;

function clip(text) {
  if (typeof text !== 'string' || text.length <= MAX_OUTPUT_CHARS) {
    return text || '';
  }

  const dropped = text.length - MAX_OUTPUT_CHARS;

  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... ${dropped} more characters, not shown]`;
}

/**
 * What the command answered, as text.
 *
 * simple-git returns a parsed object for most calls and a raw string for
 * `raw()`/`show()`. Both are worth showing: the object is what the plugin
 * actually acted on, so when a routine misbehaves this is the evidence.
 */
function summarize(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  try {
    return JSON.stringify(value, (key, val) => (
      typeof val === 'function' ? undefined : val
    ), 2);
  } catch (err) {
    return String(value);
  }
}

function record(entry) {
  const full = Object.assign({ id: nextId++ }, entry, {
    stdout: clip(entry.stdout),
    stderr: clip(entry.stderr)
  });

  entries.push(full);

  // Ring buffer: a long session should not grow without bound.
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  return full;
}

/**
 * Wrap a simple-git instance so every call is timed and logged.
 *
 * A Proxy is used rather than simple-git's own `outputHandler` because
 * that hook reports the command but not whether it succeeded or how long
 * it took, which is most of what makes the log useful.
 */
function instrument(git) {
  return new Proxy(git, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value;
      }

      return function(...args) {
        const started = Date.now();
        const command = formatCommand(prop, args);
        const origin = currentOrigin();

        let result;

        try {
          result = value.apply(target, args);
        } catch (err) {
          record({
            at: started, command, origin, ok: false,
            durationMs: Date.now() - started,
            stderr: err.message,
            error: err.message
          });
          throw err;
        }

        if (!result || typeof result.then !== 'function') {
          return result;
        }

        return result.then(
          value => {
            record({
              at: started, command, origin, ok: true,
              durationMs: Date.now() - started,
              stdout: summarize(value)
            });
            return value;
          },
          err => {
            record({
              at: started, command, origin, ok: false,
              durationMs: Date.now() - started,

              // simple-git puts git's own stderr in the message, which is
              // the actual explanation - keep it as output, not just a
              // tooltip.
              stderr: (err && err.message) || String(err),
              error: (err && err.message) || String(err)
            });
            throw err;
          }
        );
      };
    }
  });
}

/**
 * Newest first - the log is read from the top.
 */
function list({ limit = 100 } = {}) {
  return entries.slice(-limit).reverse();
}

function clear() {
  entries.length = 0;
}

module.exports = {
  instrument,
  record,
  withOrigin,
  currentOrigin,
  formatCommand,
  summarize,
  list,
  clear,
  MAX_ENTRIES,
  MAX_OUTPUT_CHARS
};
