'use strict';

const $ = id => document.getElementById(id);

// The two viewers, kept so a click in the list can highlight in both.
const viewers = {};

/**
 * Render one side into its pane, or explain why it is empty.
 *
 * A missing side is a real, common case: it means that version deleted
 * the diagram, which is exactly what the user needs to understand before
 * choosing.
 */
async function render(containerId, xml, missingText) {
  const container = $(containerId);

  if (!xml) {
    const pane = container.parentNode;
    const note = document.createElement('div');
    note.className = 'missing';
    note.textContent = missingText;
    pane.replaceChild(note, container);
    return null;
  }

  // eslint-disable-next-line no-undef
  const viewer = new BpmnJS({ container });

  try {
    await viewer.importXML(xml);
    viewer.get('canvas').zoom('fit-viewport');
    viewers[containerId] = viewer;
    return viewer;
  } catch (err) {
    container.textContent = `Could not display this version: ${err.message}`;
    return null;
  }
}

/**
 * Outline an element on one canvas.
 *
 * Silently ignores elements the canvas does not have - which is the normal
 * case rather than an error: an added element exists only on the right, a
 * removed one only on the left.
 */
function mark(viewer, id, cls) {
  if (!viewer) return;

  try {
    const registry = viewer.get('elementRegistry');

    if (registry.get(id)) {
      viewer.get('canvas').addMarker(id, cls);
    }
  } catch (err) {
    // A viewer that failed to import; nothing to mark.
  }
}

function clearFocus() {
  Object.keys(viewers).forEach(key => {
    const viewer = viewers[key];

    try {
      viewer.get('elementRegistry').forEach(el => {
        viewer.get('canvas').removeMarker(el.id, 'cgp-focus');
      });
    } catch (err) { /* nothing to clear */ }
  });
}

/**
 * Centre both canvases on the same element, so the eye does not have to
 * find it twice.
 */
function focusElement(id) {
  clearFocus();

  Object.keys(viewers).forEach(key => {
    const viewer = viewers[key];

    try {
      const element = viewer.get('elementRegistry').get(id);

      if (element) {
        viewer.get('canvas').addMarker(id, 'cgp-focus');
        viewer.get('canvas').scrollToElement(element, { top: 200, bottom: 200 });
      }
    } catch (err) { /* not on this side */ }
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;

  return node;
}

/**
 * One entry in the change list.
 *
 * The property rows are the point of the whole window: "this task changed"
 * is what a picture already tells you, and `${paymentAdapter}` becoming
 * `${stripeAdapter}` is what it cannot.
 */
function renderEntry(entry, kind) {
  const item = el('li', 'el');

  const head = el('div', 'el__head');
  head.appendChild(el('span', `tag tag--${kind}`, kind));
  head.appendChild(el('span', 'el__name', entry.name || entry.id));
  head.appendChild(el('span', 'el__type', entry.type));
  item.appendChild(head);

  (entry.changes || []).forEach(change => {
    const row = el('p', 'prop');

    row.appendChild(el('span', 'prop__label', `${change.label}: `));
    row.appendChild(el('span', 'prop__from', change.from === null ? 'not set' : change.from));
    row.appendChild(el('span', 'prop__arrow', '→'));
    row.appendChild(el('span', 'prop__to', change.to === null ? 'not set' : change.to));

    item.appendChild(row);
  });

  item.addEventListener('click', () => focusElement(entry.id));

  return item;
}

/**
 * One value on one side of a conflict, e.g. "the team: ${stripeAdapter}".
 *
 * `null` is rendered as words rather than left blank: "not set" and "not
 * present" are decisions the reader is making, so they have to be visible,
 * not an empty cell that reads as "no data".
 */
function valueRow(sideLabel, value, cls, absentText) {
  const row = document.createDocumentFragment();

  row.appendChild(el('span', 'prop3__side', sideLabel));

  if (value === null) {
    row.appendChild(el('span', `val ${cls}`, absentText));
  } else {
    row.appendChild(el('span', `val ${cls}`, value));
  }

  return row;
}

/**
 * A conflict: the only kind of entry that asks the reader for something.
 *
 * Property and add/add clashes show all three values - what it was, what
 * each side made it - because choosing between two without the starting
 * point is choosing blind. A delete/modify clash is framed as the choice it
 * actually is: one side removed the element, the other kept and changed it.
 */
function renderConflict(entry) {
  const item = el('li', 'el');

  const head = el('div', 'el__head');
  head.appendChild(el('span', 'tag tag--conflict', 'conflict'));
  head.appendChild(el('span', 'el__name', entry.name || entry.id));
  head.appendChild(el('span', 'el__type', entry.type));
  item.appendChild(head);

  if (entry.kind === 'delete/modify') {
    const removedByYou = entry.removedBy === 'ours';

    item.appendChild(el('p', 'el__note', removedByYou
      ? 'You deleted this; the team kept and changed it.'
      : 'The team deleted this; you kept and changed it.'));

    (entry.changes || []).forEach(change => {
      const block = el('div', 'prop3');
      block.appendChild(el('span', 'prop3__label', change.label));
      block.appendChild(valueRow('was', change.from, 'val--was', 'not set'));
      block.appendChild(valueRow(
        removedByYou ? 'the team' : 'you',
        change.to,
        removedByYou ? 'val--theirs' : 'val--ours',
        'not set'
      ));
      item.appendChild(block);
    });
  } else {
    const absentBase = entry.kind === 'add/add' ? 'not present' : 'not set';

    (entry.changes || []).forEach(change => {
      const block = el('div', 'prop3');
      block.appendChild(el('span', 'prop3__label', change.label));
      block.appendChild(valueRow('was', change.base, 'val--was', absentBase));
      block.appendChild(valueRow('you', change.ours, 'val--ours', 'not set'));
      block.appendChild(valueRow('the team', change.theirs, 'val--theirs', 'not set'));
      item.appendChild(block);
    });
  }

  item.addEventListener('click', () => focusElement(entry.id));

  return item;
}

/**
 * A clean auto-merge: shown so nothing is invisible, but quieter than a
 * conflict because there is no decision to make - it combines on its own.
 */
function renderClean(entry) {
  const item = el('li', 'el el--clean');

  const head = el('div', 'el__head');
  head.appendChild(el('span', 'tag tag--clean', entry.kind === 'add' ? 'added'
    : entry.kind === 'remove' ? 'removed' : 'changed'));
  head.appendChild(el('span', 'el__name', entry.name || entry.id));
  head.appendChild(el('span', 'el__type', entry.type));
  item.appendChild(head);

  if (entry.kind === 'change') {
    (entry.changes || []).forEach(change => {
      const row = el('p', 'prop');
      row.appendChild(el('span', 'prop__label', `${change.label}: `));
      row.appendChild(el('span', 'prop__from', change.from === null ? 'not set' : change.from));
      row.appendChild(el('span', 'prop__arrow', '→'));
      row.appendChild(el('span', 'prop__to', change.to === null ? 'not set' : change.to));

      const badge = el('span',
        `side-badge side-badge--${change.side === 'ours' ? 'ours' : 'theirs'}`,
        change.side === 'ours' ? 'you' : 'the team');
      row.appendChild(badge);

      item.appendChild(row);
    });
  } else if (entry.kind === 'add') {
    const who = entry.side === 'both' ? 'both of you' : entry.side === 'ours' ? 'you' : 'the team';
    item.appendChild(el('p', 'prop', `Added by ${who}.`));
  } else if (entry.kind === 'remove') {
    const who = entry.side === 'both' ? 'both of you' : entry.side === 'ours' ? 'you' : 'the team';
    item.appendChild(el('p', 'prop', `Removed by ${who}.`));
  }

  item.addEventListener('click', () => focusElement(entry.id));

  return item;
}

/**
 * The three-way view: what combines on its own, and what still needs a
 * person. Shown instead of the two-way list whenever there is a common
 * ancestor, because "these differ" is a weaker thing to know than "these
 * differ and only two of the differences actually clash".
 */
function renderMerge(merge) {
  const list = $('changeList');
  const summary = $('mergeSummary');

  if (!merge.mergeable) {
    // Fall back handled by the caller; nothing to render here.
    return false;
  }

  const { clean, conflicts } = merge;

  if (!clean.length && !conflicts.length) {
    list.appendChild(el('li', 'empty',
      'The two versions are identical apart from formatting.'));
    return true;
  }

  summary.hidden = false;

  if (merge.summary.combinesCleanly) {
    summary.appendChild(el('span', 'cleanN',
      `All ${clean.length} change${clean.length === 1 ? '' : 's'} combine cleanly`));
    summary.appendChild(document.createTextNode(
      ' — nothing conflicts. Use "Combine both" in the panel to keep every ' +
      'change; keeping a single side here would drop the other side\'s work.'));
  } else {
    summary.appendChild(el('span', 'conflN',
      `${conflicts.length} need${conflicts.length === 1 ? 's' : ''} a decision`));

    if (clean.length) {
      summary.appendChild(el('span', 'sep', '·'));
      summary.appendChild(el('span', 'cleanN', `${clean.length} combine cleanly`));
    }
  }

  // Conflicts first: they are the reason the window is open.
  conflicts.forEach(entry => {
    list.appendChild(renderConflict(entry));
    mark(viewers.ours, entry.id, 'cgp-conflict');
    mark(viewers.theirs, entry.id, 'cgp-conflict');
  });

  clean.forEach(entry => {
    list.appendChild(renderClean(entry));

    // Mark on whichever canvas carries the element, reusing the two-way
    // colours so a clean change still reads as gold/green/red.
    if (entry.kind === 'add') {
      mark(entry.side === 'ours' ? viewers.ours : viewers.theirs, entry.id, 'cgp-added');
    } else if (entry.kind === 'remove') {
      mark(entry.side === 'theirs' ? viewers.ours : viewers.theirs, entry.id, 'cgp-removed');
    } else {
      mark(viewers.ours, entry.id, 'cgp-changed');
      mark(viewers.theirs, entry.id, 'cgp-changed');
    }
  });

  return true;
}

function renderDiff(diff) {
  const list = $('changeList');

  if (!diff || !diff.comparable) {
    list.appendChild(el('li', 'empty', (diff && diff.reason) ||
      'These versions could not be compared.'));
    return;
  }

  const { added, removed, changed, moved, summary } = diff;

  if (!summary.added && !summary.removed && !summary.changed && !summary.moved) {
    list.appendChild(el('li', 'empty',
      'The two versions are identical apart from formatting.'));
    return;
  }

  // Said out loud, because it is the case somebody gets wrong by eye: two
  // diagrams that draw the same but behave differently.
  if (summary.configurationOnly) {
    const banner = $('banner');

    banner.textContent =
      'These two versions look the same on the canvas - only the ' +
      'configuration differs. Compare the values below rather than the ' +
      'pictures.';
    banner.hidden = false;
  }

  changed.forEach(entry => {
    list.appendChild(renderEntry(entry, 'changed'));
    mark(viewers.ours, entry.id, 'cgp-changed');
    mark(viewers.theirs, entry.id, 'cgp-changed');
  });

  added.forEach(entry => {
    list.appendChild(renderEntry(entry, 'added'));
    mark(viewers.theirs, entry.id, 'cgp-added');
  });

  removed.forEach(entry => {
    list.appendChild(renderEntry(entry, 'removed'));
    mark(viewers.ours, entry.id, 'cgp-removed');
  });

  moved.forEach(entry => {
    list.appendChild(renderEntry(entry, 'moved'));
  });
}

async function load() {
  try {
    const { path, name, ours, theirs, diff, merge } =
      await window.gitPlugin.invoke('getVersions');

    $('fileName').textContent = name || path;

    await Promise.all([
      render('ours', ours, 'Your version deleted this diagram.'),
      render('theirs', theirs, 'The team deleted this diagram.')
    ]);

    // Prefer the three-way view when there is a common ancestor to merge
    // against; it says which differences actually clash, which the two-way
    // list cannot. Anything else - a missing side, a merge that could not be
    // computed - falls back to the two-way diff, which always applies.
    const showedMerge = merge && merge.mergeable && renderMerge(merge);

    if (!showedMerge) {
      renderDiff(diff);
    }

    if (!ours || !theirs) {
      $('note').textContent =
        'One side deleted this diagram. Keeping that side removes the file.';
    } else if (showedMerge && !merge.summary.combinesCleanly) {
      $('note').textContent =
        'Some changes clash, so this diagram is resolved by keeping one side - ' +
        'and keeping a side takes only that side\'s changes; the other side\'s, ' +
        'clean or not, are dropped. Reopen the diagram afterwards to re-apply ' +
        'anything from the version you did not keep. Click any element to find ' +
        'it on both canvases.';
    } else {
      $('note').textContent =
        'Only one version can be kept. Whichever you discard, you can always ' +
        're-apply that change afterwards by editing the diagram again. Click ' +
        'a change on the right to find it on both canvases.';
    }
  } catch (err) {
    $('note').textContent = err.message || String(err);
  }
}

load();
