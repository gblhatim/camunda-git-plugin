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
 */

import React from 'camunda-modeler-plugin-helpers/vendor/react.js';
import { Icon } from './icons.js';

const h = React.createElement;

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

/**
 * One row of graph: the vertical lines passing through, the dot for this
 * commit, and the curves down to its parents.
 */
function RowGraph({ row, laneCount }) {
  const width = Math.max(laneCount, 1) * LANE_W;
  const mid = ROW_H / 2;
  const x = lane => lane * LANE_W + LANE_W / 2;

  const parts = [];

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
      strokeWidth: 1.6,
      opacity: 0.75
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
        strokeWidth: 1.6,
        opacity: 0.75
      }));
      return;
    }

    // A merge: curve from this dot across to the parent's lane.
    parts.push(h('path', {
      key: `merge-${i}-${lane}`,
      d: `M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + 8}, ${x(lane)} ${mid + 4}, ${x(lane)} ${ROW_H}`,
      fill: 'none',
      stroke: laneColour(lane),
      strokeWidth: 1.6,
      opacity: 0.75
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
      strokeWidth: 1.6,
      opacity: 0.75
    }));
  });

  const isMerge = row.parents.length > 1;

  parts.push(h('circle', {
    key: 'dot',
    cx: x(row.lane), cy: mid,
    r: isMerge ? DOT_R + 1 : DOT_R,
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

export function History({ history, onRefresh, busy }) {
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
        commits.map(row => h('li', {
          key: row.hash,
          className: 'cgp-commit',
          title: `${row.hash}\n${row.author}\n${row.subject}`
        },
          h(RowGraph, { row, laneCount: history.laneCount }),
          h('span', { className: 'cgp-commit__refs' },
            row.refs.map(r => h(RefBadge, { key: r.name, refKind: r.kind, name: r.name }))
          ),
          h('span', { className: 'cgp-commit__subject' }, row.subject),
          h('span', { className: 'cgp-commit__author' }, row.author),
          h('span', { className: 'cgp-commit__hash' }, row.hash.slice(0, 7))
        ))
      )
  );
}
