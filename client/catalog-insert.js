'use strict';

/**
 * Drop a catalog pattern straight into the diagram open in the editor.
 *
 * This is the half that lives *inside* bpmn-js (registered with
 * `registerBpmnJSPlugin`), so it has the editor's own services. It exposes an
 * editor action, `catalog.insert`, which the bottom panel triggers with
 * `triggerAction('catalog.insert', { xml })` - the supported way for a panel
 * plugin to reach the active editor.
 *
 * It rebuilds the pattern rather than pasting text: each node and flow is
 * recreated through `modeling`, so bpmn-js assigns fresh ids, lays out the
 * shapes and connections, writes the DI, and records one undoable step. The
 * fragment is offset to the middle of the current viewport so it lands where
 * the user is looking, not on top of existing work at the origin.
 */

function CatalogInsert(editorActions, moddle, elementFactory, modeling, canvas, bpmnFactory) {

  function isFlow(el) {
    return /:SequenceFlow$/.test(String(el.$type || ''));
  }

  // Collect the DI bounds for every shape, so the fragment can be placed with
  // roughly its authored layout.
  function collectBounds(root) {
    const bounds = {};
    const seen = new Set();

    (function walk(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) { node.forEach(walk); return; }

      if (node.$type === 'bpmndi:BPMNShape' && node.bpmnElement && node.bounds) {
        bounds[node.bpmnElement.id] = node.bounds;
      }

      Object.keys(node).forEach(key => { if (key !== '$parent') walk(node[key]); });
    })(root);

    return bounds;
  }

  async function insert(xml) {
    const { rootElement } = await moddle.fromXML(xml);
    const process = (rootElement.rootElements || [])
      .find(e => /:Process$/.test(String(e.$type)));

    if (!process) {
      throw new Error('the pattern has no process');
    }

    const bounds = collectBounds(rootElement);
    const flowElements = process.flowElements || [];

    const nodes = flowElements.filter(e => !isFlow(e) && bounds[e.id]);
    const flows = flowElements.filter(isFlow);

    if (!nodes.length) {
      throw new Error('the pattern has nothing to place');
    }

    // Offset so the fragment's top-left sits near the middle of the view.
    const minX = Math.min.apply(null, nodes.map(n => bounds[n.id].x));
    const minY = Math.min.apply(null, nodes.map(n => bounds[n.id].y));

    const view = canvas.viewbox();
    const dx = Math.round(view.x + view.width / 2 - 160) - minX;
    const dy = Math.round(view.y + view.height / 3) - minY;

    const root = canvas.getRootElement();
    const created = {};

    // Nodes first, so flows have both ends to connect.
    nodes.forEach(node => {
      const b = bounds[node.id];
      const shape = elementFactory.createShape({
        type: node.$type,
        width: b.width,
        height: b.height
      });

      const position = {
        x: Math.round(b.x + b.width / 2 + dx),
        y: Math.round(b.y + b.height / 2 + dy)
      };

      created[node.id] = modeling.createShape(shape, position, root);

      if (node.name) {
        modeling.updateProperties(created[node.id], { name: node.name });
      }
    });

    flows.forEach(flow => {
      const source = flow.sourceRef && created[flow.sourceRef.id];
      const target = flow.targetRef && created[flow.targetRef.id];

      if (!source || !target) return;

      const connection = modeling.createConnection(
        source, target, { type: 'bpmn:SequenceFlow' }, root
      );

      if (flow.name) {
        modeling.updateProperties(connection, { name: flow.name });
      }
    });

    // Leave the newly-added elements selected, so it is obvious what landed.
    canvas.scrollToElement(created[nodes[0].id]);
  }

  editorActions.register({
    'catalog.insert': function(context) {
      const xml = context && context.xml;
      if (!xml) return;

      insert(xml).catch(err =>
        console.error('[camunda-git-plugin] could not insert catalog pattern:', err));
    }
  });
}

CatalogInsert.$inject = [
  'editorActions', 'moddle', 'elementFactory', 'modeling', 'canvas', 'bpmnFactory'
];

const CatalogInsertModule = {
  __init__: [ 'cgpCatalogInsert' ],
  cgpCatalogInsert: [ 'type', CatalogInsert ]
};

export default CatalogInsertModule;
