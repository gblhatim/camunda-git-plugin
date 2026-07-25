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

/**
 * Open pull requests, in the same shape as GitLab's merge requests below,
 * so the caller does not care which host it is.
 *
 * Mergeability is the point of the list here - it is what says which ones
 * need conflicts resolved - but GitHub's *list* endpoint never includes it;
 * only the single-PR endpoint computes it. So each is enriched with one
 * extra call, capped, because a large backlog should not turn one refresh
 * into a hundred API requests.
 */
async function listGitHubPulls({ host, path }, token) {
  const server = host === 'github.com' ? 'api.github.com' : `${host}/api/v3`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(
    `https://${server}/repos/${path}/pulls?state=open&per_page=50`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }

  const pulls = await res.json();

  const items = pulls.map(pr => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user && pr.user.login,
    source: pr.head && pr.head.ref,
    target: pr.base && pr.base.ref,
    draft: !!pr.draft,
    hasConflicts: null   // filled in below where the budget allows
  }));

  const ENRICH_LIMIT = 20;

  await Promise.all(items.slice(0, ENRICH_LIMIT).map(async mr => {
    try {
      const one = await fetch(
        `https://${server}/repos/${path}/pulls/${mr.number}`, { headers }
      );

      if (!one.ok) {
        return;
      }

      const detail = await one.json();

      // `mergeable` is null while GitHub is still computing it; the
      // definitive "has conflicts" is `mergeable_state === 'dirty'`.
      if (detail.mergeable_state === 'dirty' || detail.mergeable === false) {
        mr.hasConflicts = true;
      } else if (detail.mergeable === true) {
        mr.hasConflicts = false;
      }
    } catch (err) {
      // Leave hasConflicts null - "unknown", which the UI shows honestly.
    }
  }));

  return items;
}

/**
 * Open merge requests. GitLab includes `has_conflicts` in the list itself,
 * so no per-item enrichment is needed.
 */
async function listGitLabMergeRequests({ host, path }, token) {
  const headers = {};
  if (token) {
    headers['PRIVATE-TOKEN'] = token;
  }

  const projectId = encodeURIComponent(path);
  const res = await fetch(
    `https://${host}/api/v4/projects/${projectId}/merge_requests?state=opened&per_page=50`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`GitLab API error ${res.status}: ${await res.text()}`);
  }

  const mrs = await res.json();

  return mrs.map(mr => ({
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    author: mr.author && mr.author.username,
    source: mr.source_branch,
    target: mr.target_branch,
    draft: !!mr.draft || !!mr.work_in_progress,
    hasConflicts: typeof mr.has_conflicts === 'boolean'
      ? mr.has_conflicts
      : (mr.merge_status === 'cannot_be_merged' ? true : null)
  }));
}

module.exports = {
  parseRemote,
  buildRepoUrl,
  buildGitHubCompareUrl,
  buildGitLabMrUrl,
  listGitHubIssues,
  listGitLabIssues,
  listGitHubPulls,
  listGitLabMergeRequests
};
