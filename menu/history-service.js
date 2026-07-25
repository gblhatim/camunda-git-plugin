/**
 * Commit history, with the lane assignment for drawing a branch graph.
 *
 * The lane maths lives here rather than in the renderer for one practical
 * reason: it can be tested in plain Node against a real repository and
 * compared with `git log --graph`. Graph layout bugs are near-impossible
 * to spot by eye in a UI.
 *
 * This is the one view aimed at developers rather than analysts - a DAG
 * with merge commits is exactly the mental model the rest of the plugin
 * works to hide.
 */

'use strict';

const gitService = require('./git-service');

// Field and record separators that cannot occur in commit metadata.
const FS = '\x1f';
const RS = '\x1e';

const FORMAT = [ '%H', '%P', '%an', '%aI', '%D', '%s' ].join(FS) + RS;

/**
 * Raw commits, newest first, across every branch.
 */
async function readCommits({ limit = 120 } = {}) {
  const git = gitService.getGit();

  const raw = await git.raw([
    'log',
    '--all',
    '--date-order',
    `--max-count=${limit}`,
    `--format=${FORMAT}`
  ]);

  return raw
    .split(RS)
    .map(chunk => chunk.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(chunk => {
      const [ hash, parents, author, date, refs, subject ] = chunk.split(FS);

      return {
        hash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author: author || '',
        date: date || null,
        refs: parseRefs(refs),
        subject: subject || ''
      };
    });
}

/**
 * "HEAD -> main, origin/main, tag: v1" -> structured labels.
 */
function parseRefs(refs) {
  if (!refs) {
    return [];
  }

  return refs.split(',').map(r => r.trim()).filter(Boolean).map(ref => {
    if (ref.startsWith('HEAD ->')) {
      return { name: ref.replace('HEAD ->', '').trim(), kind: 'head' };
    }
    if (ref === 'HEAD') {
      return { name: 'HEAD', kind: 'head' };
    }
    if (ref.startsWith('tag:')) {
      return { name: ref.replace('tag:', '').trim(), kind: 'tag' };
    }
    if (ref.startsWith('origin/')) {
      return { name: ref, kind: 'remote' };
    }
    return { name: ref, kind: 'local' };
  });
}

/**
 * Assign each commit a lane (column), and describe which lanes are alive
 * above and below it, so the renderer can draw the connecting lines.
 *
 * `lanes[i]` holds the hash that lane `i` is currently waiting to reach.
 * A commit takes the lane that was waiting for it; that lane then starts
 * waiting for its first parent. Extra parents (a merge) claim their own
 * lanes, and lanes waiting for the same hash collapse into the leftmost.
 */
function assignLanes(commits) {
  const lanes = [];
  const rows = [];

  const claim = hash => {
    const existing = lanes.indexOf(hash);
    if (existing !== -1) return existing;

    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = hash;
      return free;
    }

    lanes.push(hash);
    return lanes.length - 1;
  };

  commits.forEach(commit => {
    let lane = lanes.indexOf(commit.hash);

    if (lane === -1) {
      // A branch tip: nothing was waiting for it yet.
      lane = claim(commit.hash);
    }

    const before = lanes.slice();

    // This lane now follows the first parent.
    lanes[lane] = commit.parents[0] || null;

    const parentLanes = [];

    if (commit.parents[0]) {
      parentLanes.push({ hash: commit.parents[0], lane });
    }

    commit.parents.slice(1).forEach(parent => {
      parentLanes.push({ hash: parent, lane: claim(parent) });
    });

    // Two lanes waiting for the same commit are the same line - keep the
    // leftmost so converging branches visibly rejoin.
    for (let i = lanes.length - 1; i >= 0; i--) {
      if (lanes[i] && lanes.indexOf(lanes[i]) < i) {
        lanes[i] = null;
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    // Re-point each parent at the lane it *ended up* in.
    //
    // `parentLanes` was built before the collapse above, so it records where
    // a parent was first claimed rather than where it survives. For the last
    // commit on a branch that rejoins its base, those differ: the parent is
    // claimed in the feature's own lane, then collapsed into the leftmost
    // lane holding the same commit.
    //
    // The renderer draws a straight line down when a parent shares this
    // commit's lane and a curve across when it does not, so leaving the
    // stale lane here made the branch's final commit draw a line downwards
    // into a lane that no longer exists - and the next row, having no such
    // lane, drew nothing to receive it. The branch appeared to detach from
    // the one it grew out of, while the underlying history was perfectly
    // connected.
    parentLanes.forEach(parent => {
      const settled = lanes.indexOf(parent.hash);

      if (settled !== -1) {
        parent.lane = settled;
      }
    });

    rows.push({
      ...commit,
      lane,
      before,
      after: lanes.slice(),
      parentLanes
    });
  });

  const width = rows.reduce(
    (max, r) => Math.max(max, r.lane + 1, r.before.length, r.after.length),
    1
  );

  return { rows, width };
}

/**
 * The save points on the branch you are on, newest first.
 *
 * Deliberately *not* `readCommits()`. That one passes `--all` because the
 * graph is about how the branches relate; this is the list someone picks a
 * point to go back to from, and offering commits that are not on their
 * branch invites choosing one that was never part of their work.
 *
 * `changedFiles` is the count against the *previous* save point, which is
 * what makes a list of subjects scannable - "3 diagrams" tells you whether
 * the one you are looking for is likely to be this one.
 */
async function listSavePoints({ limit = 60 } = {}) {
  if (!gitService.readHeadSha()) {
    return { savePoints: [], head: null };
  }

  const git = gitService.getGit();

  // The record separator *leads* here, unlike FORMAT above.
  //
  // `--shortstat` prints its line after the formatted record, so with a
  // trailing separator each commit's stat line lands at the head of the
  // *next* chunk - every row then reports the previous commit's file count,
  // and the fields of the last one parse as undefined. Leading the record
  // with the separator makes each chunk "record + its own stat lines".
  const raw = await git.raw([
    'log',
    `--max-count=${limit}`,
    '--shortstat',
    `--format=${RS}${[ '%H', '%h', '%an', '%aI', '%s', '%D' ].join(FS)}`
  ]);

  const head = gitService.readHeadSha();

  const savePoints = raw
    .split(RS)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      // `--shortstat` appends its own line after the formatted record.
      const [ record, ...rest ] = chunk.split('\n');
      const [ hash, short, author, date, subject, refs ] = record.split(FS);

      const stat = rest.join(' ');
      const files = stat.match(/(\d+) files? changed/);

      return {
        hash,
        short,
        author: author || '',
        date: date || null,
        subject: subject || '',
        refs: parseRefs(refs),
        changedFiles: files ? Number(files[1]) : 0,
        isHead: hash === head
      };
    });

  return { savePoints, head };
}

async function getHistory(options) {
  const commits = await readCommits(options);
  const { rows, width } = assignLanes(commits);

  return { commits: rows, laneCount: width, total: rows.length };
}

/**
 * ASCII rendering of the computed graph - used by the tests to compare
 * against `git log --graph`, and handy when debugging lane assignment.
 */
function toAscii({ commits }) {
  const lines = [];

  commits.forEach(row => {
    const width = Math.max(row.before.length, row.after.length, row.lane + 1);
    const cells = [];

    for (let i = 0; i < width; i++) {
      if (i === row.lane) {
        cells.push('*');
      } else if (row.before[i] || row.after[i]) {
        cells.push('|');
      } else {
        cells.push(' ');
      }
    }

    const refs = row.refs.length ? ` (${row.refs.map(r => r.name).join(', ')})` : '';

    lines.push(`${cells.join(' ')}  ${row.hash.slice(0, 7)}${refs} ${row.subject}`);

    // A connector row, the way `git log --graph` prints `|/`, whenever this
    // commit hands off to a parent in a different lane.
    //
    // Without it this rendering could not tell a branch that rejoins its
    // base from one that simply stops - which is exactly the bug it exists
    // to catch, so it went unnoticed here for as long as the comparison
    // omitted it.
    const crossings = row.parentLanes.filter(p => p.lane !== row.lane);

    if (crossings.length) {
      // git draws the slash at the lane being *left*, sloping toward the
      // lane being joined - `|/` is "lane 0 carries on, lane 1 merges into
      // it". Drawing it at the destination instead reads as the opposite
      // movement, which defeats the point of a view meant to be compared
      // line-for-line with `git log --graph`.
      const connector = [];

      for (let i = 0; i < width; i++) {
        if (crossings.some(p => p.lane === i && p.lane > row.lane)) {
          // A lane opening to the right: a merge's second parent.
          connector.push('\\');
        } else if (i === row.lane && crossings.some(p => p.lane < row.lane)) {
          // This lane being vacated as the branch rejoins one to its left.
          connector.push('/');
        } else if (row.after[i]) {
          connector.push('|');
        } else {
          connector.push(' ');
        }
      }

      lines.push(connector.join(' '));
    }
  });

  return lines.join('\n');
}

module.exports = {
  getHistory,
  listSavePoints,
  readCommits,
  assignLanes,
  parseRefs,
  toAscii
};
