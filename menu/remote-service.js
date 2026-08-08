/**
 * GitHub / GitLab helpers: parsing a git remote URL into a web host +
 * project path, building browser URLs (repo/compare/MR pages), and
 * calling the REST APIs to list issues.
 */

'use strict';

const nodeFetch = require('node-fetch');

/**
 * Every host call is time-bounded. `node-fetch` with no timeout waits on the
 * socket forever, and a request that never resolves *and never rejects* is
 * the worst failure mode here: the caller (the merge-request list, the team
 * overview) hangs on "Loading" with no error to show and no way to recover
 * short of a restart. A slow or unreachable server must surface as a failure,
 * not a freeze, so ten seconds is the ceiling for any one request.
 */
const FETCH_TIMEOUT_MS = 10000;

function fetch(url, options) {
  return nodeFetch(url, Object.assign({ timeout: FETCH_TIMEOUT_MS }, options));
}

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
 * A single review decision from a list of GitHub reviews and the set of
 * still-requested reviewers, reduced to the vocabulary the panel shows:
 *
 *   changes_requested - someone asked for changes and has not cleared it
 *   approved          - at least one approval, nobody blocking
 *   review_requested  - a review is pending on someone
 *   none              - nobody has been asked and nobody has weighed in
 *
 * Only the *latest* review per person counts, and COMMENTED / DISMISSED
 * reviews are not a verdict - a stale "changes requested" that the reviewer
 * later approved must not keep the PR red. GitHub returns reviews oldest
 * first, so the last one seen per login wins.
 */
function computeGitHubReviewState(reviews, requestedCount) {
  const latest = new Map();

  (reviews || []).forEach(r => {
    const who = r.user && r.user.login;
    if (!who) return;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
      latest.set(who, r.state);
    }
  });

  const verdicts = Array.from(latest.values());

  if (verdicts.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (verdicts.includes('APPROVED')) return 'approved';
  if (requestedCount > 0) return 'review_requested';

  return 'none';
}

/**
 * Open pull requests, in the same shape as GitLab's merge requests below,
 * so the caller does not care which host it is.
 *
 * Mergeability is the point of the list here - it is what says which ones
 * need conflicts resolved - but GitHub's *list* endpoint never includes it;
 * only the single-PR endpoint computes it. The same call carries the
 * requested reviewers, and one more gets the reviews, so the panel can show
 * where each request stands. Both are capped, because a large backlog
 * should not turn one refresh into a hundred API requests - past the cap
 * these stay null, which the UI reads as "unknown" and shows honestly.
 *
 * That enrichment is off unless `enrich` is set, and only an explicit
 * refresh sets it. It costs two requests per pull request, so leaving it on
 * meant every visit to the tab burned dozens of calls against a budget that
 * is only 60 an hour without a token - the list would go blank on a rate
 * limit long before the user did anything wrong. Unenriched, the whole list
 * is one request, and the conflict and review columns read "unknown" until
 * asked.
 */
async function listGitHubPulls({ host, path }, token, { enrich = false } = {}) {
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
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    hasConflicts: null,   // filled in below where the budget allows
    reviewState: null
  }));

  const ENRICH_LIMIT = 20;

  if (!enrich) {
    return items;
  }

  await Promise.all(items.slice(0, ENRICH_LIMIT).map(async mr => {
    try {
      const [ one, reviewsRes ] = await Promise.all([
        fetch(`https://${server}/repos/${path}/pulls/${mr.number}`, { headers }),
        fetch(`https://${server}/repos/${path}/pulls/${mr.number}/reviews?per_page=100`, { headers })
      ]);

      if (one.ok) {
        const detail = await one.json();

        // `mergeable` is null while GitHub is still computing it; the
        // definitive "has conflicts" is `mergeable_state === 'dirty'`.
        if (detail.mergeable_state === 'dirty' || detail.mergeable === false) {
          mr.hasConflicts = true;
        } else if (detail.mergeable === true) {
          mr.hasConflicts = false;
        }

        const requested = (detail.requested_reviewers || []).length +
          (detail.requested_teams || []).length;
        const reviews = reviewsRes.ok ? await reviewsRes.json() : [];

        mr.reviewState = computeGitHubReviewState(reviews, requested);
      }
    } catch (err) {
      // Leave the unknowns null, which the UI shows honestly.
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
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    hasConflicts: typeof mr.has_conflicts === 'boolean'
      ? mr.has_conflicts
      : (mr.merge_status === 'cannot_be_merged' ? true : null),

    // Derived from what the list already carries, so no extra call per MR.
    // Thumbs-down is the clearest "blocked" signal GitLab exposes here;
    // thumbs-up stands in for an approval, and named reviewers with neither
    // yet mean a review is still pending. It is a proxy, not GitLab's formal
    // approval rules, but it is honest about where a request stands.
    reviewState: (mr.downvotes > 0)
      ? 'changes_requested'
      : (mr.upvotes > 0)
        ? 'approved'
        : ((mr.reviewers && mr.reviewers.length) ? 'review_requested' : 'none')
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
