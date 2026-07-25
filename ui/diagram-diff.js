'use strict';

const $ = id => document.getElementById(id);

function renderList(el, items, emptyText) {
  el.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    const label = item.name ? `${item.name} ` : '';
    const extra = item.attrs && item.attrs.length ? ` (${item.attrs.join(', ')})` : '';
    li.textContent = `${label}[${item.type || '?'}] ${item.id}${extra}`;
    el.appendChild(li);
  });
}

async function load() {
  try {
    const data = await window.gitPlugin.invoke('getData');
    const { fileName, currentXml, diff } = data;

    $('fileName').textContent = fileName;
    $('summary').textContent =
      `${diff.summary.added} added, ${diff.summary.changed} changed, ` +
      `${diff.summary.removed} removed, ${diff.summary.layoutChanged} moved/resized`;

    renderList($('added'), diff.added, 'No elements added.');
    renderList($('changed'), diff.changed, 'No elements changed.');
    renderList($('removed'), diff.removed, 'No elements removed.');

    // eslint-disable-next-line no-undef
    const viewer = new BpmnJS({ container: '#canvas' });
    await viewer.importXML(currentXml);
    viewer.get('canvas').zoom('fit-viewport');

    const canvas = viewer.get('canvas');
    const elementRegistry = viewer.get('elementRegistry');

    diff.added.forEach(item => {
      if (elementRegistry.get(item.id)) {
        canvas.addMarker(item.id, 'diff-added');
      }
    });

    diff.changed.forEach(item => {
      if (elementRegistry.get(item.id)) {
        canvas.addMarker(item.id, 'diff-changed');
      }
    });
  } catch (err) {
    $('error').textContent = err.message || String(err);
  }
}

load();
