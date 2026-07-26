'use strict';

/**
 * A read-only viewer for one catalog pattern, so you can see the diagram
 * before copying it or dropping it into the editor. Same bpmn-js
 * NavigatedViewer the compare window uses, loaded from local node_modules so
 * it works offline.
 */

const $ = id => document.getElementById(id);

async function boot() {
  let data;

  try {
    data = await window.gitPlugin.invoke('getDiagram');
  } catch (err) {
    return showError(err.message || String(err));
  }

  $('title').textContent = data.title || 'Catalog preview';

  // eslint-disable-next-line no-undef
  const viewer = new BpmnJS({ container: $('canvas') });

  try {
    await viewer.importXML(data.xml);
    viewer.get('canvas').zoom('fit-viewport');
  } catch (err) {
    showError(`Could not display this diagram: ${err.message}`);
  }
}

function showError(message) {
  const canvas = $('canvas');
  const note = document.createElement('div');
  note.id = 'error';
  note.textContent = message;
  canvas.parentNode.replaceChild(note, canvas);
}

boot();
