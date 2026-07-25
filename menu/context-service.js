/**
 * Everything about "where am I, and what am I connected to".
 *
 * The panel used to answer that with a branch name and a change count,
 * which is enough right up until something is wrong - and then the useful
 * questions are all ones it could not answer. Which folder is this? Which
 * server does "send to the team" actually reach? Who will this commit be
 * attributed to? Is this project set up, or is the plugin guessing?
 *
 * Those are one-line answers that turn a support conversation from
 * twenty minutes into one. They are collected here rather than assembled in
 * the renderer so that the panel and the menu see exactly the same account.
 *
 * Everything degrades: a repository with no remote, no commits, or no
 * configured identity is a normal state on someone's first day, not an
 * error. Each section fails to `null` independently, so one missing piece
 * never blanks the rest.
 */

'use strict';

const path = require('path');

const gitService = require('./git-service');
const configStore = require('./config-store');
const branchService = require('./branch-service');
const remoteService = require('./remote-service');
const naming = require('./naming');

/**
 * `git config user.name` / `user.email`, as git itself would resolve them
 * for a commit made here - repo config over global.
 *
 * One `--list` rather than two `--get` calls, because `--get` *exits 1*
 * when the key is unset. That is a normal answer here ("nobody configured
 * an identity"), but it reaches the Activity log as a failed command, and a
 * red line there should mean something went wrong. `--list` answers both
 * questions and succeeds either way.
 */
async function readIdentity(git) {
  let name = null;
  let email = null;

  try {
    const raw = await git.raw([ 'config', '--list' ]);

    raw.split('\n').forEach(line => {
      const at = line.indexOf('=');

      if (at < 0) return;

      const key = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();

      // Later entries win, which is how git resolves them: local over
      // global over system, in the order --list prints.
      if (key === 'user.name') name = value || null;
      if (key === 'user.email') email = value || null;
    });
  } catch (err) {
    // No config at all is possible on a bare new machine.
  }

  return {
    name,
    email,

    // Worth saying out loud: commits made without one are attributed to
    // whatever git falls back to, and nobody notices until a review.
    configured: !!(name && email)
  };
}

async function readHead(git) {
  // `git log` fails on a repository with no commits. Asking the refs first
  // keeps that normal state from showing up as a failed command.
  if (!gitService.readHeadSha()) {
    return null;
  }

  try {
    const raw = await git.raw([
      'log', '-1', '--format=%H%x09%h%x09%an%x09%aI%x09%s'
    ]);

    const [ sha, short, author, date, subject ] = raw.trim().split('\t');

    return { sha, short, author, date, subject };
  } catch (err) {
    return null;
  }
}

async function readRemote() {
  let url;

  try {
    url = await gitService.getRemoteUrl('origin');
  } catch (err) {
    return null;
  }

  if (!url) {
    return null;
  }

  const remote = { name: 'origin', url, host: null, path: null, provider: null, webUrl: null };

  try {
    const parsed = remoteService.parseRemote(url);

    remote.host = parsed.host;
    remote.path = parsed.path;
    remote.provider = parsed.isGitHub ? 'GitHub' : parsed.isGitLab ? 'GitLab' : null;

    try {
      remote.webUrl = remoteService.buildRepoUrl(parsed);
    } catch (err) { /* not a provider we build URLs for */ }
  } catch (err) {
    // An unparseable remote (a local path, an exotic scheme) is still worth
    // showing verbatim - it answers "where does this actually go".
  }

  return remote;
}

/**
 * How this project is set up, and whether that was decided or guessed.
 */
async function readProject(config) {
  const branches = await branchService.resolveBranches();

  return {
    model: branches.model,
    base: branches.base,
    release: branches.release,
    configured: branches.configured,
    warning: branches.warning,
    mergePolicy: config.mergePolicy === 'direct' ? 'direct' : 'review',
    jiraHost: config.jiraHost || null,
    projectKey: naming.projectKey(config)
  };
}

/**
 * The whole picture. Called by the panel on open and whenever the
 * repository changes underneath it.
 */
async function get() {
  const repoPath = gitService.getRepoPath();
  const git = gitService.getGit();
  const config = configStore.readConfig();

  const { status } = await gitService.getStatus();

  const [ identity, head, remote, project ] = await Promise.all([
    readIdentity(git), readHead(git), readRemote(), readProject(config)
  ]);

  const parsed = naming.parse(status.current || '', config);

  return {
    repo: {
      path: repoPath,
      name: path.basename(repoPath)
    },

    branch: {
      current: status.detached ? null : status.current,
      title: status.detached
        ? 'An old version - not on a workstream'
        : (status.current ? branchService.humanize(status.current) : null),
      type: parsed.type,
      ticket: parsed.ticket,
      ticketUrl: naming.ticketUrl(parsed.ticket, config),
      upstream: status.tracking || null,
      ahead: status.ahead,
      behind: status.behind,
      detached: !!status.detached
    },

    head,
    identity,
    remote,
    project,

    work: {
      changed: status.files.length,
      staged: status.staged.length,
      conflicted: status.conflicted.length,
      clean: status.isClean
    }
  };
}

module.exports = { get, readIdentity, readHead, readRemote, readProject };
