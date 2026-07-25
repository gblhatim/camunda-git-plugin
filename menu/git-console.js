/**
 * Runs git commands the user typed, for the Activity tab.
 *
 * This is the developer half of the plugin. Everything else here wraps git
 * in plain language for analysts; this deliberately does not, because the
 * point of a console is that what you typed is what runs.
 *
 * It is a **git runner, not a shell**. `git` is invoked directly with an
 * argv array - never through `sh`/`cmd` - so pipes, redirection, `&&`,
 * backticks and variable expansion are not interpreted and are rejected up
 * front rather than silently ignored. That closes the whole class of
 * "quoting turned my commit message into a command" bugs, and it means a
 * malformed request cannot reach a shell.
 *
 * It cannot leave the configured repository: the arguments that would
 * relocate or re-enter git (`-C`, `--git-dir`, `--work-tree`,
 * `--exec-path`) and the ones that run arbitrary programs (`-c`, which
 * reaches aliases and pagers) are refused. Those are escapes from the one
 * boundary this plugin has, and a console that honours them is not scoped
 * to a project at all.
 *
 * What it does NOT try to do is stop you damaging your own repository. A
 * developer asking for a console is asking for `reset --hard`; refusing it
 * would just send them to a terminal, where the plugin's log cannot see it.
 * Everything that runs here is recorded like any other command.
 */

'use strict';

const { execFile } = require('child_process');

const gitService = require('./git-service');
const commandLog = require('./command-log');
const settingsService = require('./settings-service');

// Git commands can legitimately take a while (a big clone, a slow remote),
// but an unbounded one would hang the panel with no way back.
const TIMEOUT_MS = 120000;

// Output is held in memory and shipped over the bridge as JSON.
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Interactive git would wait forever for input that can never arrive.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',

  // Without this, a push needing credentials can pop a GUI prompt behind
  // the Modeler window and look like a hang.
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never'
};

// Shell syntax is not interpreted, so accepting it would be a lie.
const SHELL_METACHARACTERS = /[|&;<>`$()]/;

// Arguments that escape the configured repository or run other programs.
const REFUSED_ARGS = new Map([
  [ '-c', 'sets git config for one command, which can run arbitrary programs through aliases and pagers' ],
  [ '--exec-path', 'changes which git binaries run' ],
  [ '-C', 'runs the command in a different directory' ],
  [ '--git-dir', 'points git at a different repository' ],
  [ '--work-tree', 'points git at a different working tree' ],
  [ '--namespace', 'changes which refs the command can see' ],
  [ '--upload-pack', 'runs a program on the far side of a transfer' ],
  [ '--receive-pack', 'runs a program on the far side of a transfer' ]
]);

/**
 * Split a command line into arguments, honouring single and double quotes
 * so a commit message survives intact.
 *
 * Quotes group; they are not otherwise special. There is no escaping and no
 * expansion, because there is no shell to escape from.
 */
function tokenize(line) {
  const tokens = [];

  let current = '';
  let quote = null;
  let started = false;

  for (const char of line) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new Error('That command has an unclosed quote.');
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Turn a typed line into the argv git will receive, or explain why it
 * cannot run. Exported so it can be tested without spawning anything.
 */
function parse(line) {
  if (typeof line !== 'string' || !line.trim()) {
    throw new Error('Type a git command first.');
  }

  if (SHELL_METACHARACTERS.test(line)) {
    throw new Error(
      'This is a git console, not a shell - pipes, redirection and command ' +
      'chaining are not available. Run one git command at a time.'
    );
  }

  const tokens = tokenize(line.trim());

  // `git status` and `status` both work; typing the binary name is habit.
  if (tokens[0] === 'git') {
    tokens.shift();
  }

  if (!tokens.length) {
    throw new Error('Type a git command first.');
  }

  tokens.forEach(token => {
    const name = token.split('=')[0];
    const reason = REFUSED_ARGS.get(name);

    if (reason) {
      throw new Error(
        `"${name}" is not available here because it ${reason}. The console ` +
        'is scoped to the project folder in Git Settings.'
      );
    }
  });

  return tokens;
}

function isEnabled() {
  return !!settingsService.read().developerMode;
}

/**
 * Run a typed command against the configured repository.
 *
 * Resolves for both success and failure: a git command that exits non-zero
 * has *answered* - "nothing to commit", "your branch is behind" - and the
 * console has to show that answer rather than an exception. Only being
 * unable to run git at all rejects.
 */
function run(line) {
  if (!isEnabled()) {
    return Promise.reject(new Error(
      'The git console is off. Turn on "Developer mode" in Git Settings to use it.'
    ));
  }

  const argv = parse(line);
  const cwd = gitService.getRepoPath();
  const command = `git ${argv.join(' ')}`;
  const started = Date.now();

  return new Promise(resolve => {
    execFile('git', argv, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: Object.assign({}, process.env, NON_INTERACTIVE_ENV)
    }, (err, stdout, stderr) => {
      const durationMs = Date.now() - started;

      // git writes progress and hints to stderr on success too, so stderr
      // alone does not mean failure - only the exit code does.
      const ok = !err;

      let error = null;

      if (err && err.killed) {
        error = `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s and was stopped.`;
      } else if (err && err.code === 'ENOENT') {
        error = 'git is not installed, or is not on the PATH Modeler was started with.';
      } else if (err) {
        error = `Exited with code ${err.code === undefined ? '?' : err.code}.`;
      }

      const entry = commandLog.record({
        at: started,
        command,
        origin: 'console',
        ok,
        durationMs,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error
      });

      resolve(entry);
    });
  });
}

module.exports = {
  run,
  parse,
  tokenize,
  isEnabled,
  REFUSED_ARGS,
  TIMEOUT_MS
};
