'use strict';

/**
 * The merge-request review window.
 *
 * A file rail on the left, two bpmn-js viewers in the middle - the diagram
 * before and after the request - and the element-level change list on the
 * right. The two viewers are *linked*: zooming or panning either one moves
 * the other to the same viewbox, so the eye compares the same region on both
 * instead of hunting for it twice. Both are NavigatedViewers, so the linking
 * covers mouse-wheel zoom and drag-pan for free; the toolbar drives the same
 * thing for people who prefer buttons.
 */

const $ = id => document.getElementById(id);

// The two live viewers and a guard that stops the "I moved, you move, which
// moves me" feedback loop when one mirrors the other.
const viewers = { before: null, after: null };
let syncing = false;

const STATUS_WORD = {
  A: [ 'ADDED', 'A' ], M: [ 'EDITED', 'M' ], D: [ 'DELETED', 'D' ],
  R: [ 'RENAMED', 'R' ], C: [ 'COPIED', 'R' ], T: [ 'RETYPED', 'M' ]
};

const DIAGRAM_EXT = /\.(bpmn|dmn|form)$/i;

function stripExt(name) {
  return String(name || '').replace(DIAGRAM_EXT, '');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// ------------------------------------------------------------ viewers

function destroyViewers() {
  [ 'before', 'after' ].forEach(key => {
    if (viewers[key]) {
      try { viewers[key].destroy(); } catch (err) { /* already gone */ }
      viewers[key] = null;
    }
  });
}

/**
 * Render one XML into its container, or explain the empty side - an added
 * diagram has no "before", a deleted one has no "after", and saying so is
 * more use than a blank canvas.
 */
async function renderSide(key, containerId, xml, emptyClass, emptyText) {
  const container = $(containerId);
  container.innerHTML = '';

  if (!xml) {
    const note = el('div', `missing ${emptyClass}`, emptyText);
    container.appendChild(note);
    return null;
  }

  // eslint-disable-next-line no-undef
  const viewer = new BpmnJS({ container });

  try {
    await viewer.importXML(xml);
    viewer.get('canvas').zoom('fit-viewport');
    viewers[key] = viewer;
    return viewer;
  } catch (err) {
    container.textContent = `Could not display this version: ${err.message}`;
    return null;
  }
}

/**
 * Mirror one viewer's viewbox onto the other whenever the user moves it.
 */
function linkViewers(a, b) {
  if (!a || !b) return;

  a.get('eventBus').on('canvas.viewbox.changed', event => {
    if (syncing) return;

    syncing = true;
    try {
      b.get('canvas').viewbox(event.viewbox);
    } finally {
      syncing = false;
    }
  });
}

function eachViewer(fn) {
  if (viewers.before) fn(viewers.before);
  if (viewers.after) fn(viewers.after);
}

/**
 * Fit each viewer to its own diagram, then align the second to the first so
 * the pair starts on the same region. Guarded, so the fitting itself does
 * not bounce back through the link.
 */
function fitBoth() {
  syncing = true;
  try {
    eachViewer(v => v.get('canvas').zoom('fit-viewport'));

    if (viewers.before && viewers.after) {
      viewers.after.get('canvas').viewbox(viewers.before.get('canvas').viewbox());
    }
  } finally {
    syncing = false;
  }
}

function zoomBy(factor) {
  const primary = viewers.before || viewers.after;
  if (!primary) return;

  const canvas = primary.get('canvas');
  // Zooming the primary fires viewbox.changed, which the link carries to the
  // other - so both stay locked without touching the second here.
  canvas.zoom(canvas.zoom() * factor);
}

/**
 * Outline an element on whichever side has it. Silently skips a side that
 * does not - an added element is only on the "after", a removed one only on
 * the "before".
 */
function mark(viewer, id, cls) {
  if (!viewer) return;

  try {
    const registry = viewer.get('elementRegistry');
    if (registry.get(id)) {
      viewer.get('canvas').addMarker(id, cls);
    }
  } catch (err) { /* a viewer that failed to import */ }
}

function focusElement(id) {
  eachViewer(viewer => {
    try {
      viewer.get('elementRegistry').forEach(e =>
        viewer.get('canvas').removeMarker(e.id, 'cgp-focus'));
    } catch (err) { /* nothing to clear */ }
  });

  eachViewer(viewer => {
    try {
      const element = viewer.get('elementRegistry').get(id);
      if (element) {
        viewer.get('canvas').addMarker(id, 'cgp-focus');
        viewer.get('canvas').scrollToElement(element, { top: 150, bottom: 150 });
      }
    } catch (err) { /* not on this side */ }
  });
}

// -------------------------------------------------------- change list

function renderChanges(diff) {
  const list = $('changeList');
  const banner = $('banner');
  list.innerHTML = '';
  banner.hidden = true;

  if (!diff) {
    list.appendChild(el('li', 'empty',
      'This file is not a diagram, or one side does not exist to compare.'));
    return;
  }

  if (!diff.comparable) {
    list.appendChild(el('li', 'empty',
      diff.reason || 'These versions could not be compared.'));
    return;
  }

  const { added, removed, changed, moved, summary } = diff;

  if (!summary.added && !summary.removed && !summary.changed && !summary.moved) {
    list.appendChild(el('li', 'empty',
      'The two versions are identical apart from formatting.'));
    return;
  }

  if (summary.configurationOnly) {
    banner.textContent =
      'These look the same on the canvas - only the configuration differs. ' +
      'Compare the values below rather than the pictures.';
    banner.hidden = false;
  }

  const entry = (item, kind, tagClass, tagWord) => {
    const li = el('li', 'el');
    li.onclick = () => focusElement(item.id);

    const head = el('div', 'el__head');
    head.appendChild(el('span', `tag tag--${tagClass}`, tagWord));
    head.appendChild(el('span', 'el__name', item.name || item.id));
    if (item.type) head.appendChild(el('span', 'el__type', item.type));
    li.appendChild(head);

    (item.changes || []).forEach(change => {
      const p = el('div', 'prop');
      p.appendChild(el('span', 'prop__label', `${change.label}: `));
      if (change.from !== undefined && change.from !== null && change.from !== '') {
        p.appendChild(el('span', 'prop__from', change.from));
        p.appendChild(el('span', 'prop__arrow', '→'));
      }
      p.appendChild(el('span', 'prop__to', change.to === null || change.to === undefined ? '(removed)' : change.to));
      li.appendChild(p);
    });

    list.appendChild(li);
  };

  changed.forEach(c => entry(c, 'changed', 'changed', 'Changed'));
  added.forEach(c => entry(c, 'added', 'added', 'Added'));
  removed.forEach(c => entry(c, 'removed', 'removed', 'Removed'));
  moved.forEach(c => entry(c, 'moved', 'moved', 'Moved'));

  // Colour the canvases: added on the "after", removed on the "before",
  // changed and moved on both.
  changed.forEach(c => { mark(viewers.before, c.id, 'cgp-changed'); mark(viewers.after, c.id, 'cgp-changed'); });
  added.forEach(c => mark(viewers.after, c.id, 'cgp-added'));
  removed.forEach(c => mark(viewers.before, c.id, 'cgp-removed'));
  moved.forEach(c => { mark(viewers.before, c.id, 'cgp-changed'); mark(viewers.after, c.id, 'cgp-changed'); });
}

// --------------------------------------------------------- open a file

let openPath = null;

async function openFile(file) {
  if (!file.isDiagram) return;

  openPath = file.path;

  Array.from(document.querySelectorAll('.file')).forEach(node =>
    node.classList.toggle('on', node.dataset.path === file.path));

  $('placeholder').hidden = true;
  $('panes').hidden = false;
  $('toolbar').hidden = false;
  $('openName').textContent = stripExt(file.name);
  $('changeList').innerHTML = '';

  destroyViewers();

  let data;
  try {
    data = await window.gitPlugin.invoke('getFile', file.path);
  } catch (err) {
    $('changeList').innerHTML = '';
    $('changeList').appendChild(el('li', 'empty', `Could not load this file: ${err.message}`));
    return;
  }

  // Guard against a race: a second file opened while this one loaded.
  if (openPath !== file.path) return;

  await Promise.all([
    renderSide('before', 'before', data.before, 'removed',
      data.status === 'A' ? 'Added in this request - there is no earlier version.'
        : 'This version could not be read.'),
    renderSide('after', 'after', data.after, 'added',
      data.status === 'D' ? 'Deleted in this request.'
        : 'This version could not be read.')
  ]);

  linkViewers(viewers.before, viewers.after);
  linkViewers(viewers.after, viewers.before);
  fitBoth();

  renderChanges(data.diff);
}

// --------------------------------------------------------------- boot

function renderFileList(review) {
  const list = $('fileList');
  list.innerHTML = '';

  if (!review.files.length) {
    list.appendChild(el('div', 'empty', 'This request changes no files.'));
    return;
  }

  review.files.forEach(file => {
    const [ word, code ] = STATUS_WORD[file.status] || [ file.status || '?', 'M' ];

    const row = el('div', `file${file.isDiagram ? '' : ' text'}`);
    row.dataset.path = file.path;
    row.appendChild(el('span', `st st--${code}`, word));

    const name = el('span', 'file__name', file.isDiagram ? stripExt(file.name) : file.name);
    name.title = file.path;
    row.appendChild(name);

    if (file.isDiagram) {
      row.onclick = () => openFile(file);
    } else {
      row.title = 'Not a diagram - open it in your editor to review.';
    }

    list.appendChild(row);
  });
}

async function boot() {
  try {
    const review = await window.gitPlugin.invoke('getReview');

    $('title').textContent = 'Reviewing merge request';

    const branches = $('branches');
    branches.innerHTML = '';
    branches.appendChild(el('code', null, review.source));
    branches.appendChild(el('span', 'arrow', '→'));
    branches.appendChild(el('code', null, review.target));
    branches.appendChild(document.createTextNode(
      `   ·   ${review.fileCount} file${review.fileCount === 1 ? '' : 's'} changed` +
      (review.diagramCount ? `, ${review.diagramCount} diagram${review.diagramCount === 1 ? '' : 's'}` : '')
    ));

    renderFileList(review);

    // Open the first changed diagram straight away - the point of the window
    // is the picture, so do not make the user hunt for it.
    const firstDiagram = review.files.find(f => f.isDiagram);
    if (firstDiagram) openFile(firstDiagram);
  } catch (err) {
    $('placeholder').textContent = err.message || String(err);
  }
}

$('zoomIn').onclick = () => zoomBy(1.2);
$('zoomOut').onclick = () => zoomBy(1 / 1.2);
$('zoomFit').onclick = () => fitBoth();

boot();
