/**
 * Hover a task, see how it is actually configured.
 *
 * A BPMN diagram shows the *shape* of a process - which task follows which -
 * and hides everything that makes it run: who a user task is assigned to,
 * which form it opens, what properties are pinned to it, which listeners
 * fire. Reading any of that means clicking the element and opening the
 * properties panel, one element at a time. When the question is "is this the
 * task with the SLA property?" across a diagram of thirty, that is thirty
 * clicks.
 *
 * This puts the configuration on hover: pause over a task and a card
 * summarises its form, assignment, properties, listeners and mappings. Read
 * only - it never changes anything, so it is safe to sweep across a whole
 * diagram with.
 *
 * It registers as a bpmn-js module (`registerBpmnJSPlugin`), so it lives
 * inside the editor rather than the bottom panel - the only surface in this
 * plugin that does.
 *
 * The extraction is deliberately tolerant of how the model was parsed.
 * Camunda's `camunda:*` configuration is typed moddle objects when the
 * camunda extension is loaded (`bo.assignee`, `formField.label`) and raw
 * attributes when it is not (`bo.$attrs['camunda:assignee']`, a generic
 * child's `$attrs`). Everything here reads through accessors that try the
 * typed shape first and the raw one second, so it produces the same card
 * either way.
 */

'use strict';

// --------------------------------------------------------- moddle reading

/**
 * The local name of a moddle type: `camunda:UserTask` -> `usertask`.
 * Lower-cased so a typed `camunda:FormData` and a raw `camunda:formData`
 * compare equal.
 */
function local(node) {
  return String((node && node.$type) || '').split(':').pop().toLowerCase();
}

/**
 * A property, whether it arrived typed or as a namespaced attribute.
 */
function attr(node, name) {
  if (!node) {
    return undefined;
  }

  if (node[name] !== undefined && node[name] !== null && node[name] !== '') {
    return node[name];
  }

  const attrs = node.$attrs || {};
  const value = attrs[`camunda:${name}`] !== undefined ? attrs[`camunda:${name}`] : attrs[name];

  return value === '' ? undefined : value;
}

/**
 * A moddle collection: the typed array if the extension named it, otherwise
 * the generic `$children`.
 */
function kids(node, typedProp) {
  if (node && Array.isArray(node[typedProp]) && node[typedProp].length) {
    return node[typedProp];
  }

  return (node && Array.isArray(node.$children)) ? node.$children : [];
}

/**
 * The text carried by a node, wherever moddle put it.
 *
 * Three different properties depending on the element: a documentation's is
 * `text`, a formal expression's (a flow condition, a mapping value) is
 * `body`, and a generically-parsed element's is `$body`. Missing `body` is
 * why a sequence flow's condition - the one piece of configuration a flow
 * has - produced no card at all.
 */
function text(node) {
  if (!node) {
    return null;
  }

  return node.text || node.body || node.$body || null;
}

// ---------------------------------------------------------- element kinds

// The type, in the reader's words. Anything not here still shows its
// configuration; it just gets its raw BPMN type as a heading.
const TYPE_LABELS = {
  'bpmn:UserTask': 'User task',
  'bpmn:ServiceTask': 'Service task',
  'bpmn:ScriptTask': 'Script task',
  'bpmn:BusinessRuleTask': 'Business rule task',
  'bpmn:SendTask': 'Send task',
  'bpmn:ReceiveTask': 'Receive task',
  'bpmn:ManualTask': 'Manual task',
  'bpmn:CallActivity': 'Call activity',
  'bpmn:SubProcess': 'Sub-process',
  'bpmn:StartEvent': 'Start event',
  'bpmn:EndEvent': 'End event',
  'bpmn:IntermediateCatchEvent': 'Intermediate event',
  'bpmn:IntermediateThrowEvent': 'Intermediate event',
  'bpmn:BoundaryEvent': 'Boundary event',
  'bpmn:ExclusiveGateway': 'Exclusive gateway',
  'bpmn:ParallelGateway': 'Parallel gateway',
  'bpmn:SequenceFlow': 'Sequence flow'
};

function typeLabel(bo) {
  return TYPE_LABELS[bo.$type] || String(bo.$type || '').replace(/^bpmn:/, '');
}

// --------------------------------------------------------------- sections

function assignment(bo) {
  const rows = [];

  const add = (label, name) => {
    const value = attr(bo, name);
    if (value) rows.push({ label, value: String(value) });
  };

  add('Assignee', 'assignee');
  add('Candidate groups', 'candidateGroups');
  add('Candidate users', 'candidateUsers');
  add('Due date', 'dueDate');
  add('Follow-up date', 'followUpDate');
  add('Priority', 'priority');

  return rows.length ? { title: 'Assignment', rows } : null;
}

function form(bo, ext) {
  const rows = [];
  const fields = [];

  const key = attr(bo, 'formKey');
  const ref = attr(bo, 'formRef');

  if (key) rows.push({ label: 'Form key', value: String(key) });

  if (ref) {
    const binding = attr(bo, 'formRefBinding');
    rows.push({ label: 'Form reference', value: String(ref) + (binding ? ` (${binding})` : '') });
  }

  const formData = ext.find(v => local(v) === 'formdata');

  if (formData) {
    kids(formData, 'fields').forEach(field => {
      if (local(field) !== 'formfield') {
        return;
      }

      fields.push({
        id: attr(field, 'id') || '',
        label: attr(field, 'label') || attr(field, 'id') || '(unnamed)',
        type: attr(field, 'type') || ''
      });
    });
  }

  if (!rows.length && !fields.length) {
    return null;
  }

  return { title: 'Form', rows, fields };
}

function properties(ext) {
  const container = ext.find(v => local(v) === 'properties');

  if (!container) {
    return null;
  }

  const rows = kids(container, 'values')
    .filter(p => local(p) === 'property')
    .map(p => ({ label: attr(p, 'name') || '(unnamed)', value: String(attr(p, 'value') || '') }))
    .filter(r => r.label !== '(unnamed)' || r.value);

  return rows.length ? { title: 'Properties', rows } : null;
}

/**
 * The single most useful thing about a service task, and the one a picture
 * never shows: what it actually calls.
 */
function implementation(bo) {
  const rows = [];

  const add = (label, name) => {
    const value = attr(bo, name);
    if (value) rows.push({ label, value: String(value) });
  };

  add('Java class', 'class');
  add('Expression', 'expression');
  add('Delegate expression', 'delegateExpression');
  add('External task topic', 'topic');
  add('Decision reference', 'decisionRef');
  add('Called element', 'calledElement');

  const script = attr(bo, 'scriptFormat');
  if (script) rows.push({ label: 'Script format', value: String(script) });

  return rows.length ? { title: 'Implementation', rows } : null;
}

function listeners(ext) {
  const rows = [];

  ext.forEach(v => {
    const kind = local(v);

    if (kind !== 'tasklistener' && kind !== 'executionlistener') {
      return;
    }

    const impl = attr(v, 'class') || attr(v, 'expression') ||
      attr(v, 'delegateExpression') || '(script)';

    const on = attr(v, 'event') || '?';
    const what = kind === 'tasklistener' ? 'Task' : 'Execution';

    rows.push({ label: `${what} · ${on}`, value: String(impl) });
  });

  return rows.length ? { title: 'Listeners', rows } : null;
}

function mappings(ext) {
  const io = ext.find(v => local(v) === 'inputoutput');

  if (!io) {
    return null;
  }

  const rows = [];

  const describe = (param, arrow) => {
    const name = attr(param, 'name') || '(unnamed)';

    // A mapping's value is a simple string, or a nested script / list / map.
    // The simple case is the common one and the only one worth a line here.
    const value = attr(param, 'value') !== undefined
      ? String(attr(param, 'value'))
      : (text(param) || '(structured)');

    rows.push({ label: `${arrow} ${name}`, value });
  };

  kids(io, 'inputParameters')
    .filter(p => local(p) === 'inputparameter')
    .forEach(p => describe(p, 'in'));

  kids(io, 'outputParameters')
    .filter(p => local(p) === 'outputparameter')
    .forEach(p => describe(p, 'out'));

  return rows.length ? { title: 'Input / output', rows } : null;
}

function multiInstance(bo) {
  const loop = bo.loopCharacteristics;

  if (!loop || !/multiinstance/i.test(local(loop))) {
    return null;
  }

  const rows = [ {
    label: 'Runs',
    value: attr(loop, 'isSequential') === true || attr(loop, 'isSequential') === 'true'
      ? 'one after another'
      : 'in parallel'
  } ];

  const collection = attr(loop, 'collection');
  if (collection) rows.push({ label: 'For each', value: String(collection) });

  const element = attr(loop, 'elementVariable');
  if (element) rows.push({ label: 'As', value: String(element) });

  return { title: 'Multi-instance', rows };
}

// ------------------------------------------------------------- assembling

/**
 * The whole card for one element, or null when there is nothing worth
 * showing - which is most of them. A plain sequence flow with no condition,
 * an unconfigured gateway: hovering those should do nothing rather than pop
 * an empty box.
 */
function detailsFor(element) {
  const bo = element && element.businessObject;

  if (!bo || !bo.$type) {
    return null;
  }

  const ext = (bo.extensionElements && bo.extensionElements.values) || [];

  const sections = [
    form(bo, ext),
    assignment(bo),
    implementation(bo),
    properties(ext),
    listeners(ext),
    mappings(ext),
    multiInstance(bo)
  ].filter(Boolean);

  // A sequence flow's condition is its whole configuration, and it is worth
  // showing on its own.
  const condition = bo.conditionExpression && text(bo.conditionExpression);

  if (condition) {
    sections.unshift({ title: 'Condition', rows: [ { label: 'Only when', value: condition } ] });
  }

  const documentation = (bo.documentation || [])
    .map(text)
    .filter(Boolean)
    .join('\n');

  if (!sections.length && !documentation) {
    return null;
  }

  return {
    id: bo.id,
    type: typeLabel(bo),
    name: bo.name || null,
    sections,
    documentation: documentation || null
  };
}

// --------------------------------------------------------------- rendering

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}

/**
 * Build the card as DOM, never as an HTML string.
 *
 * Every value here - a form label, a property value, a condition - is text
 * the diagram's author typed, and a task named `<img onerror=...>` is not a
 * threat worth taking. `textContent` closes the whole question.
 */
function renderCard(details) {
  const card = el('div', 'cgp-taskcard');

  const head = el('div', 'cgp-taskcard__head');
  head.appendChild(el('span', 'cgp-taskcard__type', details.type));
  if (details.name) head.appendChild(el('span', 'cgp-taskcard__name', details.name));
  card.appendChild(head);

  details.sections.forEach(section => {
    card.appendChild(el('div', 'cgp-taskcard__section', section.title));

    section.rows.forEach(row => {
      const line = el('div', 'cgp-taskcard__row');
      line.appendChild(el('span', 'cgp-taskcard__label', row.label));
      line.appendChild(el('span', 'cgp-taskcard__value', row.value));
      card.appendChild(line);
    });

    (section.fields || []).forEach(field => {
      const line = el('div', 'cgp-taskcard__field');
      line.appendChild(el('span', 'cgp-taskcard__fieldname', field.label));
      if (field.type) line.appendChild(el('span', 'cgp-taskcard__fieldtype', field.type));
      card.appendChild(line);
    });
  });

  if (details.documentation) {
    card.appendChild(el('div', 'cgp-taskcard__doc', details.documentation));
  }

  return card;
}

// ------------------------------------------------------- the bpmn-js module

// Long enough not to flicker while the mouse crosses the canvas, short
// enough to feel like a tooltip rather than a wait.
const HOVER_DELAY_MS = 350;

function TaskDetailsOverlay(eventBus, overlays, elementRegistry) {
  let timer = null;
  let shownFor = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const hide = () => {
    clearTimer();

    if (shownFor) {
      try {
        overlays.remove({ element: shownFor });
      } catch (err) {
        // Element already gone (deleted while hovered); nothing to remove.
      }
      shownFor = null;
    }
  };

  const show = element => {
    const details = detailsFor(element);

    if (!details) {
      return;
    }

    hide();

    // Anchored to the element's top-left and offset upward, so the card sits
    // above the shape and does not cover the thing being asked about. It
    // does not scale with zoom - a tooltip you cannot read when zoomed out
    // is not a tooltip.
    overlays.add(element, 'cgp-task-details', {
      position: { bottom: 6, left: 0 },
      scale: false,
      show: { minZoom: 0.2 },
      html: renderCard(details)
    });

    shownFor = element;
  };

  eventBus.on('element.hover', event => {
    const element = event.element;

    if (!element || element === shownFor) {
      return;
    }

    clearTimer();
    timer = setTimeout(() => show(element), HOVER_DELAY_MS);
  });

  eventBus.on('element.out', () => hide());

  // Any edit or navigation should not leave a stale card floating: the model
  // may have just changed under it.
  eventBus.on([ 'element.click', 'commandStack.changed', 'canvas.viewbox.changing' ], hide);
}

TaskDetailsOverlay.$inject = [ 'eventBus', 'overlays', 'elementRegistry' ];

const TaskDetailsModule = {
  __init__: [ 'cgpTaskDetails' ],
  cgpTaskDetails: [ 'type', TaskDetailsOverlay ]
};

export default TaskDetailsModule;
export { detailsFor, TYPE_LABELS };
