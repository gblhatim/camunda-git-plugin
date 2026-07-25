/**
 * The branch graph.
 *
 * Lane assignment is done in the main process (menu/history-service.js)
 * where it can be tested against `git log --graph`; this file only draws
 * what it is told.
 *
 * Each row renders its own small SVG rather than one canvas for the whole
 * list, so rows stay in normal document flow and line up with their text
 * without any absolute positioning.
 *
 * Two things beyond drawing lines:
 *
 *   - Hovering a row raises a label card with the parts the one-line row
 *     has to truncate: the full message, who and when, the branches and
 *     tags sitting on it. It is positioned with a measured rect rather than
 *     pure CSS so the bottom panel's own scroll cannot clip it.
 *   - Opening a row (a click) expands a detail panel that lazily fetches
 *     the commit's body and the exact files it changed, marked with the
 *     same ADDED/EDITED/DELETED vocabulary the rest of the plugin uses.
 */

import React from 'camunda-modeler-plugin-helpers/vendor/react.js';
import { Icon } from './icons.js';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

const LANE_W = 14;   // horizontal distance between lanes
const ROW_H = 26;    // must match .cgp-commit height in styles.css
const DOT_R = 3.5;

// Distinct but muted; index by lane so a branch keeps its colour down the
// list. Deliberately not the status colours - these mean "different line",
// not "good/bad".
const LANE_COLOURS = [
  '#1565c0', '#2e7d32', '#b8860b', '#8e24aa',
  '#00838f', '#c62828', '#5d4037', '#455a64'
];

function laneColour(i) {
  return LANE_COLOURS[i % LANE_COLOURS.length];
}

// Porcelain letters to the words the rest of the plugin shows, so the
// history reads the same as Source Control does.
const FILE_STATUS = {
  A: { word: 'ADDED', cls: 'added' },
  M: { word: 'EDITED', cls: 'edited' },
  D: { word: 'DELETED', cls: 'deleted' },
  R: { word: 'RENAMED', cls: 'info' },
  C: { word: 'COPIED', cls: 'info' },
  T: { word: 'RETYPED', cls: 'info' }
};

const DIAGRAM_EXT = /\.(bpmn|dmn|form)$/i;

function prettyPath(path) {
  return String(path || '').replace(DIAGRAM_EXT, '');
}

/**
 * "3 days ago", "just now" - the coarse form is the point. Anyone who
 * needs the exact timestamp has it a line below.
 */
function relativeTime(iso) {
  if (!iso) return '';

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const secs = Math.round((Date.now() - then) / 1000);

  if (secs < 45) return 'just now';

  const units = [
    [ 60, 'second' ], [ 60, 'minute' ], [ 24, 'hour' ],
    [ 7, 'day' ], [ 4.35, 'week' ], [ 12, 'month' ], [ Infinity, 'year' ]
  ];

  let value = secs;
  let unit = 'second';

  for (let i = 0; i < units.length; i++) {
    unit = units[i][1];
    if (value < units[i][0]) break;
    value = value / units[i][0];
  }

  const n = Math.round(value);
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

function fullDate(iso) {
  if (!iso) return '';

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  return d.toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/**
 * One row of graph: the vertical lines passing through, the dot for this
 * commit, and the curves down to its parents.
 */
function RowGraph({ row, laneCount, highlight }) {
  const width = Math.max(laneCount, 1) * LANE_W;
  const mid = ROW_H / 2;
  const x = lane => lane * LANE_W + LANE_W / 2;

  const parts = [];
  const lit = lane => (highlight && lane === row.lane ? 1 : 0.75);
  const wide = lane => (highlight && lane === row.lane ? 2.4 : 1.6);

  // Lines coming in from above: any lane alive before this commit.
  row.before.forEach((hash, lane) => {
    if (!hash) return;

    // The lane holding this commit stops at the dot; others pass through.
    const endsHere = lane === row.lane;

    parts.push(h('line', {
      key: `in-${lane}`,
      x1: x(lane), y1: 0,
      x2: x(lane), y2: endsHere ? mid : ROW_H,
      stroke: laneColour(lane),
      strokeWidth: wide(lane),
      opacity: lit(lane)
    }));
  });

  // Lines leaving downward, and the curve into each parent's lane.
  row.parentLanes.forEach(({ lane }, i) => {
    if (lane === row.lane) {
      parts.push(h('line', {
        key: `out-${lane}`,
        x1: x(row.lane), y1: mid,
        x2: x(lane), y2: ROW_H,
        stroke: laneColour(lane),
        strokeWidth: wide(lane),
        opacity: lit(lane)
      }));
      return;
    }

    // A merge: curve from this dot across to the parent's lane.
    parts.push(h('path', {
      key: `merge-${i}-${lane}`,
      d: `M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + 8}, ${x(lane)} ${mid + 4}, ${x(lane)} ${ROW_H}`,
      fill: 'none',
      stroke: laneColour(lane),
      strokeWidth: wide(row.lane),
      opacity: lit(row.lane)
    }));
  });

  // Lanes that only exist below (a branch tip appearing) still need a stub.
  row.after.forEach((hash, lane) => {
    if (!hash) return;
    const drawn = row.parentLanes.some(p => p.lane === lane);
    if (drawn || lane === row.lane) return;
    if (row.before[lane]) return;   // already drawn as a pass-through

    parts.push(h('line', {
      key: `stub-${lane}`,
      x1: x(lane), y1: mid,
      x2: x(lane), y2: ROW_H,
      stroke: laneColour(lane),
      strokeWidth: wide(lane),
      opacity: lit(lane)
    }));
  });

  const isMerge = row.parents.length > 1;

  parts.push(h('circle', {
    key: 'dot',
    cx: x(row.lane), cy: mid,
    r: (isMerge ? DOT_R + 1 : DOT_R) + (highlight ? 1 : 0),
    fill: isMerge ? 'var(--cgp-bg, #fff)' : laneColour(row.lane),
    stroke: laneColour(row.lane),
    strokeWidth: isMerge ? 2 : 1
  }));

  return h('svg', {
    className: 'cgp-commit__graph',
    width,
    height: ROW_H,
    style: { width: `${width}px`, height: `${ROW_H}px`, flex: `0 0 ${width}px` }
  }, parts);
}

function RefBadge({ refKind, name }) {
  const icon = refKind === 'tag' ? 'Tag' : refKind === 'head' ? 'Commit' : 'Branch';

  return h('span', { className: `cgp-ref cgp-ref--${refKind}` },
    h(Icon, { name: icon, size: 11 }),
    h('span', null, name)
  );
}

/**
 * The label that follows the cursor down the graph. Pure presentation of
 * data the row already has, so it appears instantly with no fetch.
 */
function HoverCard({ row, rect }) {
  if (!row || !rect) return null;

  // Sit just below the row, clamped into the viewport so a commit near the
  // bottom edge does not push the card off-screen.
  const width = 320;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const below = rect.bottom + 6;
  const above = rect.top - 6;
  const openUp = below > window.innerHeight - 150;

  const style = {
    position: 'fixed',
    left: `${left}px`,
    width: `${width}px`,
    zIndex: 60,
    pointerEvents: 'none'
  };

  if (openUp) {
    style.bottom = `${window.innerHeight - above}px`;
  } else {
    style.top = `${below}px`;
  }

  const isMerge = row.parents.length > 1;

  return h('div', { className: 'cgp-hovercard', style },
    row.refs.length ? h('div', { className: 'cgp-hovercard__refs' },
      row.refs.map(r => h(RefBadge, { key: r.name, refKind: r.kind, name: r.name }))
    ) : null,
    h('div', { className: 'cgp-hovercard__subject' }, row.subject),
    h('div', { className: 'cgp-hovercard__meta' },
      isMerge
        ? h('span', { className: 'cgp-chip cgp-chip--merge' },
          h(Icon, { name: 'Merge', size: 11 }), ' Merge')
        : null,
      h('span', null, row.author),
      h('span', { className: 'cgp-dot-sep' }, '·'),
      h('span', { title: fullDate(row.date) }, relativeTime(row.date))
    ),
    h('div', { className: 'cgp-hovercard__hash' }, row.hash.slice(0, 12)),
    h('div', { className: 'cgp-hovercard__hint' }, 'Click to see what changed')
  );
}

/**
 * The expanded detail for an opened commit: message body, dates, parents,
 * and the files it touched. Lazily fetched; renders its own loading and
 * error states so opening one never blocks the list.
 */
function CommitDetail({ row, fetchCommit }) {
  const [ detail, setDetail ] = useState(null);
  const [ error, setError ] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setDetail(null);
    setError(null);

    if (!fetchCommit) return undefined;

    fetchCommit(row.hash)
      .then(d => { if (alive.current) setDetail(d); })
      .catch(err => { if (alive.current) setError(err.message); });

    return () => { alive.current = false; };
  }, [ row.hash, fetchCommit ]);

  if (error) {
    return h('div', { className: 'cgp-commit-detail' },
      h('p', { className: 'cgp-empty' }, `Could not load this commit: ${error}`));
  }

  if (!detail) {
    return h('div', { className: 'cgp-commit-detail' },
      h('p', { className: 'cgp-empty' }, 'Loading the details...'));
  }

  const authored = fullDate(detail.authorDate);
  const committed = fullDate(detail.commitDate);
  const diagrams = detail.files.filter(f => f.isDiagram).length;

  const fileSummary = !detail.fileCount
    ? (detail.isMerge ? 'A merge - it combined branches without changing files on its own.'
      : 'No files changed.')
    : `${detail.fileCount} file${detail.fileCount === 1 ? '' : 's'} changed` +
      (diagrams ? ` · ${diagrams} diagram${diagrams === 1 ? '' : 's'}` : '');

  return h('div', { className: 'cgp-commit-detail' },
    h('div', { className: 'cgp-commit-detail__head' },
      h('span', { className: 'cgp-commit-detail__subject' }, detail.subject),
      detail.isMerge && h('span', { className: 'cgp-chip cgp-chip--merge' },
        h(Icon, { name: 'Merge', size: 11 }), ' Merge')
    ),

    detail.body && h('pre', { className: 'cgp-commit-detail__body' }, detail.body),

    h('dl', { className: 'cgp-meta' },
      h('div', { className: 'cgp-meta__row' },
        h('dt', null, 'Author'),
        h('dd', null, detail.email ? `${detail.author} <${detail.email}>` : detail.author)),
      h('div', { className: 'cgp-meta__row' },
        h('dt', null, 'When'),
        h('dd', null, `${authored}  (${relativeTime(detail.authorDate)})`,
          committed && committed !== authored
            ? h('span', { className: 'cgp-sub' }, ` · committed ${committed}`)
            : null)),
      h('div', { className: 'cgp-meta__row' },
        h('dt', null, detail.parents.length === 1 ? 'Parent' : 'Parents'),
        h('dd', { className: 'cgp-mono' },
          detail.parents.length
            ? detail.parents.map(p => p.slice(0, 8)).join('  ')
            : 'none - this is the first save point')),
      detail.refs.length ? h('div', { className: 'cgp-meta__row' },
        h('dt', null, 'Here'),
        h('dd', null, h('span', { className: 'cgp-commit__refs' },
          detail.refs.map(r => h(RefBadge, { key: r.name, refKind: r.kind, name: r.name }))))
      ) : null
    ),

    h('div', { className: 'cgp-commit-detail__files' },
      h('div', { className: 'cgp-eyebrow' }, fileSummary),
      detail.files.length ? h('ul', { className: 'cgp-filelist' },
        detail.files.map((f, i) => {
          const s = FILE_STATUS[f.status] || { word: f.status || '?', cls: 'muted' };

          return h('li', { key: `${f.path}-${i}`, className: 'cgp-filelist__row', title: f.path },
            h('span', { className: `cgp-tag cgp-tag--${s.cls}` }, s.word),
            h('span', { className: 'cgp-filelist__name' },
              f.isDiagram ? prettyPath(f.path) : f.path,
              f.from ? h('span', { className: 'cgp-sub' },
                `  ← ${f.isDiagram ? prettyPath(f.from) : f.from}`) : null)
          );
        })
      ) : null
    )
  );
}

export function History({ history, onRefresh, busy, fetchCommit }) {
  const [ hover, setHover ] = useState(null);
  const [ openHash, setOpenHash ] = useState(null);

  const leaveTimer = useRef(null);

  const onEnter = useCallback((row, event) => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }

    // The open row already shows everything the card would, in full, right
    // below it - a floating "click to see what changed" over it would only
    // contradict itself.
    if (row.hash === openHash) {
      setHover(null);
      return;
    }

    setHover({ row, rect: event.currentTarget.getBoundingClientRect() });
  }, [ openHash ]);

  const onLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHover(null), 60);
  }, []);

  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  if (!history) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Loading history...'));
  }

  if (history.error) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, history.error));
  }

  const commits = history.commits || [];

  return h('div', { className: 'cgp-panel' },
    h('div', { className: 'cgp-toolbar' },
      h('span', { className: 'cgp-eyebrow' },
        `${commits.length} commit${commits.length === 1 ? '' : 's'} across all branches`),
      h('span', { className: 'cgp-toolbar__spacer' }),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: onRefresh
      }, h(Icon, { name: 'Renew', size: 13 }), ' Refresh')
    ),

    !commits.length
      ? h('p', { className: 'cgp-empty' }, 'No commits yet.')
      : h('ul', { className: 'cgp-commits' },
        commits.map(row => {
          const open = row.hash === openHash;

          return h(React.Fragment, { key: row.hash },
            h('li', {
              className: `cgp-commit${open ? ' cgp-commit--open' : ''}`,
              onMouseEnter: e => onEnter(row, e),
              onMouseLeave: onLeave,
              onClick: () => setOpenHash(open ? null : row.hash)
            },
              h(RowGraph, {
                row,
                laneCount: history.laneCount,
                highlight: open || Boolean(hover && hover.row.hash === row.hash)
              }),
              h('span', { className: 'cgp-commit__refs' },
                row.refs.map(r => h(RefBadge, { key: r.name, refKind: r.kind, name: r.name }))
              ),
              h('span', { className: 'cgp-commit__subject' }, row.subject),
              h('span', { className: 'cgp-commit__author' }, row.author),
              h('span', { className: 'cgp-commit__hash' }, row.hash.slice(0, 7))
            ),
            open ? h('li', { className: 'cgp-commit-detail__wrap' },
              h(CommitDetail, { row, fetchCommit })
            ) : null
          );
        })
      ),

    hover ? h(HoverCard, { row: hover.row, rect: hover.rect }) : null
  );
}
