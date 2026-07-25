/**
 * GitHub / GitLab helpers: parsing a git remote URL into a web host +
 * project path, building browser URLs (repo/compare/MR pages), and
 * calling the REST APIs to list issues.
 */

'use strict';

const fetch = require('node-fetch');

/**
 * Parse a git remote URL (ssh or https form) into { host, path, isGitHub, isGitLab }.
 * `path` is the "owner/repo" (GitHub) or full namespace path (GitLab), without `.git`.
 *
 * Examples handled:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://gitlab.example.com/group/sub/repo.git
 *   ssh://git@gitlab.example.com:22/group/sub/repo.git
 */
function parseRemote(remoteUrl) {
  if (!remoteUrl) {
    throw new Error('No remote URL to parse.');
  }

  let host;
  let repoPath;

  const sshMatch = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+)$/);
  const httpMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+)$/);

  if (sshMatch) {
    host = sshMatch[1];
    repoPath = sshMatch[2];
  } else if (httpMatch) {
    host = httpMatch[1];
    repoPath = httpMatch[2];
  } else {
    throw new Error(`Could not parse remote URL: ${remoteUrl}`);
  }

  repoPath = repoPath.replace(/\.git$/, '').replace(/\/$/, '');

  return {
    host,
    path: repoPath,
    isGitHub: host === 'github.com',
    isGitLab: host.includes('gitlab')
  };
}

function buildRepoUrl({ host, path }) {
  return `https://${host}/${path}`;
}

/**
 * The "open a pull request" page for two branches.
 *
 * Built from the remote's own host rather than a hardcoded github.com:
 * `isGitHub` is an exact match on github.com, so a GitHub Enterprise
 * install (github.acme.com) is not recognised as GitHub and falls through
 * to here as the default. Hardcoding the host sent those users to
 * github.com/<their-repo-path> - a page that does not exist, on a server
 * that should never have seen the path.
 *
 * Enterprise uses the same /compare/ URL shape, so using the real host is
 * both the fix and all that is needed.
 */
function buildGitHubCompareUrl({ host, path }, base, compare) {
  const server = host || 'github.com';

  return `https://${server}/${path}/compare/${encodeURIComponent(base)}...${encodeURIComponent(compare)}?expand=1`;
}

function buildGitLabMrUrl({ host, path }, source, target) {
  const qs = new URLSearchParams({
    'merge_request[source_branch]': source,
    'merge_request[target_branch]': target
  });
  return `https://${host}/${path}/-/merge_requests/new?${qs.toString()}`;
}

async function listGitHubIssues({ path }, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(
    `https://api.github.com/repos/${path}/issues?state=open&per_page=50`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }

  const issues = await res.json();

  // GitHub returns PRs as "issues" too - filter those out.
  return issues
    .filter(issue => !issue.pull_request)
    .map(issue => ({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      author: issue.user && issue.user.login,
      createdAt: issue.created_at
    }));
}

async function listGitLabIssues({ host, path }, token) {
  const headers = {};
  if (token) {
    headers['PRIVATE-TOKEN'] = token;
  }

  const projectId = encodeURIComponent(path);
  const res = await fetch(
    `https://${host}/api/v4/projects/${projectId}/issues?state=opened&per_page=50`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`GitLab API error ${res.status}: ${await res.text()}`);
  }

  const issues = await res.json();

  return issues.map(issue => ({
    number: issue.iid,
    title: issue.title,
    url: issue.web_url,
    author: issue.author && issue.author.username,
    createdAt: issue.created_at
  }));
}

module.exports = {
  parseRemote,
  buildRepoUrl,
  buildGitHubCompareUrl,
  buildGitLabMrUrl,
  listGitHubIssues,
  listGitLabIssues
};
