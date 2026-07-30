/**
 * The team's picture on one screen.
 *
 * Every other tab answers "what should *I* do next?". This one answers "where
 * is *everyone*?" - the question a lead, a scrum master, or anyone coordinating
 * a release actually has, and the one the plugin made you piece together from
 * four tabs before this. It is read-only: it runs no git command that changes
 * anything and never writes to the host.
 *
 * It joins three things the plugin already knows: the workstreams (from
 * `branch-service.listWorkstreams`), how far each has run ahead of and behind
 * the shared branch (the same measurement `next-action` makes, against the
 * *server's* copy so a stale local branch does not lie), and the open merge
 * requests keyed by their source branch. The join itself - `assemble` - is a
 * pure function so it can be tested without a network or a repository.
 *
 * Loaded on tab activation and when the repository moves, never on the status
 * poll: it makes one network call (the merge-request list) and a `rev-list`
 * per workstream, which is fine on demand and wrong every five seconds.
 */

'use strict';

const branchService = require('./branch-service');
const mergeRequestService = require('./merge-request-service');
const nextAction = require('./next-action');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A workstream nobody has touched in this long is flagged as stale - the
 * overview's "has anyone forgotten about this?" signal. Longer than a merge
 * request's threshold on purpose: a branch mid-development can reasonably go
 * quiet for a few days, so two weeks is where silence starts to mean drift.
 */
const STALE_DAYS = 14;

/**
 * The backstop for the one network call. `remote-service` already times each
 * host request out, so this only catches a pathological case that slips past
 * that - but a tab that can hang is worth a second, independent guard, and
 * it costs nothing when the call returns promptly. A little longer than the
 * per-request ceiling so a normal slow-but-working fetch is not cut off.
 */
const MR_BACKSTOP_MS = 12000;

/**
 * Resolve `promise`, or reject with `message` if it takes longer than `ms`.
 * The timer is cleared on settle so it never keeps the process alive.
 */
function withTimeout(promise, ms, message) {
  let timer;

  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([ promise, guard ]).finally(() => clearTimeout(timer));
}

function ageInDays(iso, now) {
  if (!iso) return null;

  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;

  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/**
 * Join the workstreams, the ahead/behind counts, and the open merge requests
 * into one row per workstream, most-in-need-of-attention first.
 *
 * Pure: everything it needs is passed in. `counts` is a map of branch name to
 * `{ ahead, behind }`; `mrsBySource` maps a source branch to its open request.
 * The shared branches themselves (main, release) are dropped - they are not
 * workstreams and nobody "works on" them.
 */
function assemble({ workstreams, mrsBySource, counts, now, staleDays }) {
  const at = now instanceof Date ? now : new Date(now);
  const limit = typeof staleDays === 'number' ? staleDays : STALE_DAYS;

  const streams = (workstreams && workstreams.streams) || [];
  const mrs = mrsBySource || {};
  const c = counts || {};

  const rows = streams
    .filter(s => !s.isMain && !s.isRelease)
    .map(s => {
      const ageDays = ageInDays(s.lastChange, at);
      const mr = mrs[s.name] || null;
      const count = c[s.name] || {};

      return {
        name: s.name,
        title: s.title,
        ticket: s.ticket || null,
        ticketUrl: s.ticketUrl || null,
        owner: s.lastAuthor || null,
        lastChange: s.lastChange || null,
        lastMessage: s.lastMessage || '',
        ageDays,
        stale: ageDays !== null && ageDays >= limit,
        isCurrent: !!s.isCurrent,
        onServer: !!s.onServer,
        localOnly: !!s.localOnly,
        ahead: count.ahead || 0,
        behind: count.behind || 0,
        mr: mr
          ? {
            number: mr.number,
            url: mr.url,
            // The source is this row's branch; the target is what it merges
            // into. Both are needed to open the visual review from here.
            target: mr.target || null,
            hasConflicts: typeof mr.hasConflicts === 'boolean' ? mr.hasConflicts : null,
            reviewState: mr.reviewState || null,
            stale: !!mr.stale,
            draft: !!mr.draft
          }
          : null
      };
    });

  const mrConflicts = r => (r.mr && r.mr.hasConflicts === true ? 1 : 0);

  // Attention first: an open request that conflicts, then a stale workstream,
  // then whichever is furthest behind the shared branch, then most recently
  // touched so the order is stable and reads newest-down within a tier.
  rows.sort((a, b) =>
    (mrConflicts(b) - mrConflicts(a)) ||
    ((b.stale === true) - (a.stale === true)) ||
    (b.behind - a.behind) ||
    String(b.lastChange).localeCompare(String(a.lastChange))
  );

  return rows;
}

/**
 * The countable headline the tab leads with, so the health of the board is
 * legible before reading a single row.
 */
function summarize(rows) {
  return {
    active: rows.length,
    stale: rows.filter(r => r.stale).length,
    unsent: rows.filter(r => r.localOnly).length,
    withOpenMr: rows.filter(r => r.mr).length,
    conflicting: rows.filter(r => r.mr && r.mr.hasConflicts === true).length
  };
}

/**
 * Gather the live data and assemble the overview. Degrades rather than fails:
 * a project with no host, or a host we cannot reach, still returns every
 * workstream - just without the merge-request column, and it says why.
 */
async function get() {
  const workstreams = await branchService.listWorkstreams();
  const base = workstreams.main;

  // The merge-request list is the only network call here and the only part
  // that can legitimately be unavailable (no remote, no token, an ordinary
  // git host). Catch it so the rest of the picture still renders - and cap it
  // with a backstop timeout so a server that hangs rather than fails can
  // never freeze the whole tab. The workstreams are worth showing on their
  // own; the request column can say it could not be reached.
  const mrsBySource = {};
  let mr = { supported: false, provider: null, error: null };

  try {
    const list = await withTimeout(
      mergeRequestService.list(),
      MR_BACKSTOP_MS,
      'The team server did not respond in time - showing workstreams only.'
    );

    mr = {
      supported: !!list.supported,
      provider: list.provider || null,
      error: list.error || null
    };

    (list.items || []).forEach(item => {
      if (item.source) mrsBySource[item.source] = item;
    });
  } catch (err) {
    mr = { supported: false, provider: null, error: err.message };
  }

  // Measure every workstream against the server's copy of the shared branch,
  // the same reference next-action uses. `serverTip` falls back to the local
  // branch when there is no remote, and `countAheadOfBase` returns 0 rather
  // than throwing on a ref that will not resolve, so this is safe offline.
  const shared = await branchService.serverTip(base);

  const targets = (workstreams.streams || []).filter(s => !s.isMain && !s.isRelease);
  const counts = {};

  await Promise.all(targets.map(async s => {
    const ref = await branchService.serverTip(s.name);

    counts[s.name] = shared
      ? {
        ahead: await nextAction.countAheadOfBase(shared, ref),
        behind: await nextAction.countAheadOfBase(ref, shared)
      }
      : { ahead: 0, behind: 0 };
  }));

  const now = new Date();
  const rows = assemble({ workstreams, mrsBySource, counts, now, staleDays: STALE_DAYS });

  return {
    base,
    release: workstreams.release && workstreams.release !== base ? workstreams.release : null,
    generatedAt: now.toISOString(),
    staleDays: STALE_DAYS,
    mr,
    summary: summarize(rows),
    rows
  };
}

module.exports = { get, assemble, summarize, STALE_DAYS };
