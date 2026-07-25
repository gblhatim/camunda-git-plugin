/**
 * A semantic diff of two BPMN documents, down to the configuration.
 *
 * Why this is not just `bpmn-js-differ`: that library answers the question
 * it was built for - what changed *structurally* - and is good at it. It is
 * not built to answer "what changed about this task", and on the cases that
 * matter most here it does not.
 *
 * Measured against two revisions of the same process whose only differences
 * were configuration:
 *
 *   camunda:delegateExpression  ${paymentAdapter} -> ${stripeAdapter}
 *   camunda:asyncBefore         false -> true
 *   conditionExpression         amount > 100 -> amount > 500
 *   timeDuration                PT5M -> PT30M
 *
 * it reported the service task as **unchanged**, the sequence flow as
 * changed with an empty attribute list, and the timer with a `newValue` of
 * `null`. Nothing there is wrong for a structural diff - those properties
 * live in `$attrs` and inside `extensionElements`, which a shape-oriented
 * differ has no reason to descend into. It is simply the wrong instrument.
 *
 * And these are the changes that matter. Two revisions of a process can be
 * pixel-identical on the canvas and behave completely differently: a
 * different delegate, a longer timer, an input mapping that no longer
 * passes the order total. Someone choosing between two versions during a
 * conflict has to be able to see that, and a side-by-side of two pictures
 * that look the same tells them nothing.
 *
 * So this walks both documents generically rather than through typed
 * accessors - `camunda:*` attributes arrive as raw strings in `$attrs`, and
 * extension elements are untyped generic elements without the Camunda
 * moddle extension, so their content is in `$children` and `$body`.
 * Walking generically means new Camunda properties, and other vendors'
 * namespaces, are covered without this file knowing about them.
 */

'use strict';

const BpmnModdle = require('bpmn-moddle');

// Diagram interchange: position and size. Deliberately excluded from the
// property comparison and reported separately - "the box moved" and "the
// timer changed from 5 minutes to 30" should never appear as the same kind
// of finding.
const DI_TYPES = /^bpmndi:|^dc:|^di:/;

/**
 * Readable names for the properties people actually change.
 *
 * A fallback prettifier handles everything else, so this only has to cover
 * the ones whose raw name is genuinely unhelpful.
 */
const LABELS = {
  'name': 'Name',
  'id': 'Id',
  '@camunda:delegateExpression': 'Delegate expression',
  '@camunda:class': 'Java class',
  '@camunda:expression': 'Expression',
  '@camunda:resultVariable': 'Result variable',
  '@camunda:topic': 'External task topic',
  '@camunda:type': 'Implementation type',
  '@camunda:asyncBefore': 'Asynchronous before',
  '@camunda:asyncAfter': 'Asynchronous after',
  '@camunda:exclusive': 'Exclusive',
  '@camunda:jobPriority': 'Job priority',
  '@camunda:candidateGroups': 'Candidate groups',
  '@camunda:candidateUsers': 'Candidate users',
  '@camunda:assignee': 'Assignee',
  '@camunda:dueDate': 'Due date',
  '@camunda:followUpDate': 'Follow-up date',
  '@camunda:priority': 'Priority',
  '@camunda:formKey': 'Form key',
  '@camunda:decisionRef': 'Decision reference',
  '@camunda:variableMappingClass': 'Variable mapping class',
  '@camunda:collection': 'Collection',
  '@camunda:elementVariable': 'Element variable',
  'conditionExpression.body': 'Condition',
  'conditionExpression.text': 'Condition',
  'documentation.text': 'Documentation',
  'documentation[0].text': 'Documentation',

  // Event definitions are addressed by index in the path; the index is
  // stripped before lookup so these match however many there are.
  'timeDuration.text': 'Timer duration',
  'timeCycle.text': 'Timer cycle',
  'timeDate.text': 'Timer date',
  'condition.text': 'Condition',
  'escalationRef': 'Escalation',
  'default': 'Default flow',
  'calledElement': 'Called process',
  'messageRef': 'Message',
  'signalRef': 'Signal',
  'errorRef': 'Error'
};

/**
 * `camunda:asyncBefore` -> "Asynchronous before"; `timeDuration.text` ->
 * "Time duration". Good enough that an unmapped property is still readable.
 */
function labelFor(key) {
  if (LABELS[key]) {
    return LABELS[key];
  }

  // Container prefixes carry no meaning for a reader - "Event definitions 0
  // time duration" is the raw path showing through. Strip them and try the
  // table again before falling back to prettifying.
  const stripped = String(key)
    // Two segments: the list, then the definition's own type or index -
    // `eventDefinitions.TimerEventDefinition.timeDuration.text`.
    .replace(/^eventDefinitions\.[^.]*\./, '')
    .replace(/^eventDefinitions\./, '')
    .replace(/^extensionElements\.values\./, '')
    .replace(/^extensionElements\./, '')
    .replace(/^loopCharacteristics\./, 'Multi-instance ')

    // `inputOutput.inputParameter[limit].text` reads better as
    // "Input parameter 'limit'" than as its own path.
    .replace(/^inputOutput\./, '')
    .replace(/\[([^\]]+)\]\.text$/, " '$1'")
    .replace(/\[([^\]]+)\]/g, " '$1'");

  if (LABELS[stripped]) {
    return LABELS[stripped];
  }

  const cleaned = String(stripped)
    .replace(/^@/, '')
    .replace(/^[a-z]+:/i, '')
    .replace(/\.text$/, '')
    .replace(/\.body$/, '')
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/\./g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();

  if (!cleaned) {
    return String(key);
  }

  // Sentence case, not Title Case: camel-splitting produces "input
  // Parameter", and capitalising every word gives "Input Parameter", which
  // reads like a proper noun. Quoted names are left exactly as the author
  // wrote them.
  return cleaned.split(' ').map((word, i) => {
    if (i === 0) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }

    return word.startsWith("'") ? word : word.charAt(0).toLowerCase() + word.slice(1);
  }).join(' ');
}

function isModdle(value) {
  return !!value && typeof value === 'object' && typeof value.$type === 'string';
}

/**
 * Every BPMN element in the document that carries an id, indexed by it.
 *
 * DI is skipped: it describes where things are drawn, which is handled
 * separately.
 */
function indexElements(root) {
  const byId = new Map();
  const seen = new Set();

  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) {
      return;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (isModdle(node)) {
      if (DI_TYPES.test(node.$type)) {
        return;
      }

      if (node.id && !byId.has(node.id)) {
        byId.set(node.id, node);
      }
    }

    Object.keys(node).forEach(key => {
      if (key === '$parent' || key === 'di') {
        return;
      }

      walk(node[key]);
    });
  };

  walk(root);

  return byId;
}

/**
 * A stable key for one entry of a list.
 *
 * Positional keys are wrong here in two ways. They collide - two
 * `camunda:inputParameter` children under the same `inputOutput` both
 * flatten to the same path, and the second silently overwrites the first,
 * so a changed mapping can vanish from the diff entirely. And they shift:
 * inserting one listener at the top renumbers every listener below it, so
 * an addition reads as "everything changed".
 *
 * So: identify by name or id where there is one, then by type when that is
 * unique among its siblings, and only fall back to position when there is
 * genuinely nothing else to go on.
 */
function entryKey(item, index, siblings) {
  if (!isModdle(item)) {
    return String(index);
  }

  const named = item.name || item.id || (item.$attrs && item.$attrs.name);
  const type = String(item.$type || 'item').replace(/^[a-z]+:/i, '');

  if (named) {
    return `${type}[${named}]`;
  }

  const sameType = (siblings || []).filter(
    other => isModdle(other) && other.$type === item.$type
  );

  return sameType.length === 1 ? type : `${type}[${index}]`;
}

/**
 * One element's own configuration, flattened to `path -> text`.
 *
 * Recursion stops at any nested element that has an id of its own: that one
 * is indexed separately, and attributing its changes to its parent as well
 * would report the same edit two or three times over.
 */
function ownProperties(element) {
  const out = {};

  const put = (path, value) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    out[path] = String(value);
  };

  const walk = (node, prefix, depth) => {
    if (!node || depth > 8) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${prefix}.${entryKey(item, i, node)}`, depth + 1);
      });
      return;
    }

    if (isModdle(node)) {
      if (DI_TYPES.test(node.$type)) {
        return;
      }

      // A nested element with its own id is its own entry.
      if (prefix && node.id) {
        return;
      }

      // Namespaced attributes - where every camunda:* property lives.
      Object.keys(node.$attrs || {}).forEach(attr => {
        put(prefix ? `${prefix}.@${attr}` : `@${attr}`, node.$attrs[attr]);
      });

      // Text content, e.g. an expression body or a script.
      if (node.$body) {
        put(prefix ? `${prefix}.text` : 'text', node.$body);
      }

      // Untyped children, e.g. camunda:inputOutput without the Camunda
      // moddle extension loaded.
      if (Array.isArray(node.$children)) {
        node.$children.forEach((child, i) => {
          const key = entryKey(child, i, node.$children);
          walk(child, prefix ? `${prefix}.${key}` : key, depth + 1);
        });
      }

      Object.keys(node).forEach(key => {
        if (key.startsWith('$') || key === 'di' || key === 'id') {
          return;
        }

        const value = node[key];

        // References are compared by id, not by walking into the target.
        if (isModdle(value) && value.id && key !== 'conditionExpression' &&
            key !== 'documentation') {
          put(prefix ? `${prefix}.${key}` : key, value.id);
          return;
        }

        walk(value, prefix ? `${prefix}.${key}` : key, depth + 1);
      });

      return;
    }

    if (typeof node === 'object') {
      Object.keys(node).forEach(key => {
        walk(node[key], prefix ? `${prefix}.${key}` : key, depth + 1);
      });
      return;
    }

    put(prefix, node);
  };

  walk(element, '', 0);

  // An entry keyed by its own name repeats that name as a property. Dropping
  // it is not cosmetic: leaving it in means renaming a parameter reports two
  // changes for one edit.
  Object.keys(out).forEach(key => {
    const named = key.match(/\[([^\]]+)\]\.name$/);

    if (named && out[key] === named[1]) {
      delete out[key];
    }
  });

  return out;
}

/**
 * Where each element is drawn, so a pure move can be reported as a move.
 */
function indexBounds(root) {
  const byElement = new Map();
  const seen = new Set();

  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) {
      return;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (isModdle(node) && node.bounds && node.bpmnElement && node.bpmnElement.id) {
      const b = node.bounds;
      byElement.set(node.bpmnElement.id, `${b.x},${b.y},${b.width},${b.height}`);
    }

    Object.keys(node).forEach(key => {
      if (key !== '$parent') walk(node[key]);
    });
  };

  walk(root);

  return byElement;
}

function describe(element) {
  return {
    id: element.id,
    type: String(element.$type || '').replace(/^bpmn:/, ''),
    name: element.name || null
  };
}

async function parse(xml) {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);

  return rootElement;
}

/**
 * Compare two versions of a diagram.
 *
 * Both sides are optional: a conflict where one side deleted the file is an
 * ordinary case, and the caller renders it as such rather than being handed
 * an error.
 */
async function compare(oursXml, theirsXml) {
  if (!oursXml || !theirsXml) {
    return {
      comparable: false,
      reason: !oursXml && !theirsXml
        ? 'Neither version has this diagram.'
        : 'One version deleted this diagram, so there is nothing to compare.'
    };
  }

  let ours;
  let theirs;

  try {
    [ ours, theirs ] = await Promise.all([ parse(oursXml), parse(theirsXml) ]);
  } catch (err) {
    return {
      comparable: false,
      reason: `One of the versions is not valid BPMN, so they cannot be ` +
        `compared: ${err.message}`
    };
  }

  const a = indexElements(ours);
  const b = indexElements(theirs);

  const aBounds = indexBounds(ours);
  const bBounds = indexBounds(theirs);

  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];

  b.forEach((element, id) => {
    if (!a.has(id)) {
      added.push(describe(element));
    }
  });

  a.forEach((element, id) => {
    if (!b.has(id)) {
      removed.push(describe(element));
      return;
    }

    const before = ownProperties(element);
    const after = ownProperties(b.get(id));

    const keys = new Set(Object.keys(before).concat(Object.keys(after)));
    const changes = [];

    keys.forEach(key => {
      if (before[key] === after[key]) {
        return;
      }

      changes.push({
        key,
        label: labelFor(key),
        from: before[key] === undefined ? null : before[key],
        to: after[key] === undefined ? null : after[key]
      });
    });

    if (changes.length) {
      changes.sort((x, y) => x.label.localeCompare(y.label));
      changed.push(Object.assign(describe(element), { changes }));
    } else if (aBounds.get(id) !== bBounds.get(id) && aBounds.has(id) && bBounds.has(id)) {
      // Only worth mentioning when nothing else about the element moved -
      // "it was dragged" is noise next to "the timer changed".
      moved.push(describe(element));
    }
  });

  const order = (x, y) => String(x.name || x.id).localeCompare(String(y.name || y.id));

  added.sort(order);
  removed.sort(order);
  changed.sort(order);
  moved.sort(order);

  return {
    comparable: true,
    added,
    removed,
    changed,
    moved,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      moved: moved.length,

      // The distinction the panel leads with: two versions that differ only
      // in configuration look identical side by side, and saying so up front
      // is what stops somebody choosing by eye.
      configurationOnly: !added.length && !removed.length && !moved.length &&
        changed.length > 0
    }
  };
}

/**
 * Two property maps hold the same values under the same keys.
 *
 * Used to answer "did this side actually change anything" against the
 * ancestor - the question that separates a clean auto-merge from a real
 * conflict.
 */
function sameProps(a, b) {
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));

  return !Array.from(keys).some(key => a[key] !== b[key]);
}

const nz = value => (value === undefined ? null : value);

/**
 * The differing properties between two versions of one element, as
 * `{ label, base, ours, theirs }` rows. `basis` supplies the third column:
 * a real ancestor for an add/add clash, or null when there is none.
 */
function differingProps(oProps, tProps, bProps) {
  const keys = new Set(Object.keys(oProps).concat(Object.keys(tProps)));
  const changes = [];

  keys.forEach(key => {
    if (oProps[key] === tProps[key]) {
      return;
    }

    changes.push({
      key,
      label: labelFor(key),
      base: bProps ? nz(bProps[key]) : null,
      ours: nz(oProps[key]),
      theirs: nz(tProps[key])
    });
  });

  changes.sort((x, y) => x.label.localeCompare(y.label));

  return changes;
}

/**
 * What the surviving side changed against the ancestor, for a
 * delete/modify clash. `from -> to` because there is only one side to show:
 * the other one deleted the element.
 */
function survivingChanges(bProps, otherProps) {
  const keys = new Set(Object.keys(bProps).concat(Object.keys(otherProps)));
  const changes = [];

  keys.forEach(key => {
    if (bProps[key] === otherProps[key]) {
      return;
    }

    changes.push({
      key,
      label: labelFor(key),
      from: nz(bProps[key]),
      to: nz(otherProps[key])
    });
  });

  changes.sort((x, y) => x.label.localeCompare(y.label));

  return changes;
}

/**
 * A three-way merge analysis: for every change, decide whether it applies
 * on its own or whether both sides touched the same thing differently.
 *
 * This is the question `compare` cannot answer. `compare` sees that ours
 * and theirs differ; it cannot tell whether that difference is a change one
 * person made that the other never touched - safe to keep - or the same
 * property pulled two ways, which is the only thing a human actually has to
 * decide. The ancestor is what separates the two, and it is already fetched
 * (conflict-service reads all three index stages) and, until now, discarded.
 *
 * Phase 1 is analysis only: it classifies, it does not synthesise merged
 * XML. Resolution still goes through the existing keep-a-side path - but the
 * caller can now say "12 of these combine cleanly, 2 need you" instead of
 * asking someone to pick a whole side blind.
 *
 * Layout is deliberately out of scope. A pure move is a DI change, which
 * `ownProperties` already excludes, and file-level resolution cannot
 * preserve one anyway; reuniting layouts is a Phase 2 concern.
 */
async function merge(baseXml, oursXml, theirsXml) {
  if (!baseXml || !oursXml || !theirsXml) {
    return {
      mergeable: false,
      reason: 'A three-way merge needs a common ancestor and both versions.'
    };
  }

  let base;
  let ours;
  let theirs;

  try {
    [ base, ours, theirs ] = await Promise.all([
      parse(baseXml), parse(oursXml), parse(theirsXml)
    ]);
  } catch (err) {
    return {
      mergeable: false,
      reason: `One of the versions is not valid BPMN, so they cannot be ` +
        `merged: ${err.message}`
    };
  }

  const B = indexElements(base);
  const O = indexElements(ours);
  const T = indexElements(theirs);

  const clean = [];
  const conflicts = [];

  const ids = new Set(
    Array.from(B.keys()).concat(Array.from(O.keys()), Array.from(T.keys()))
  );

  ids.forEach(id => {
    const inB = B.has(id);
    const inO = O.has(id);
    const inT = T.has(id);

    // ---- Not in the ancestor: one or both sides added it. ----
    if (!inB) {
      if (inO && !inT) {
        clean.push(Object.assign(describe(O.get(id)), { kind: 'add', side: 'ours' }));
        return;
      }

      if (inT && !inO) {
        clean.push(Object.assign(describe(T.get(id)), { kind: 'add', side: 'theirs' }));
        return;
      }

      // Both added an element under the same id. Identical content is a
      // clean add; anything else is a genuine clash with no ancestor to
      // arbitrate it.
      const changes = differingProps(ownProperties(O.get(id)), ownProperties(T.get(id)), null);

      if (changes.length) {
        conflicts.push(Object.assign(describe(O.get(id)), { kind: 'add/add', changes }));
      } else {
        clean.push(Object.assign(describe(O.get(id)), { kind: 'add', side: 'both' }));
      }

      return;
    }

    // ---- In the ancestor, gone from one or both sides. ----
    if (!inO && !inT) {
      clean.push(Object.assign(describe(B.get(id)), { kind: 'remove', side: 'both' }));
      return;
    }

    if (!inO || !inT) {
      const survivor = inO ? O.get(id) : T.get(id);
      const bProps = ownProperties(B.get(id));
      const survProps = ownProperties(survivor);

      // Deleted on one side, untouched on the other: the deletion stands.
      if (sameProps(bProps, survProps)) {
        clean.push(Object.assign(describe(B.get(id)), {
          kind: 'remove',
          side: inO ? 'theirs' : 'ours'
        }));
        return;
      }

      // Deleted on one side, edited on the other: only a human can say
      // whether the edit or the deletion wins.
      conflicts.push(Object.assign(describe(survivor), {
        kind: 'delete/modify',
        removedBy: inO ? 'theirs' : 'ours',
        changes: survivingChanges(bProps, survProps)
      }));
      return;
    }

    // ---- Present in all three: decide property by property. ----
    const bProps = ownProperties(B.get(id));
    const oProps = ownProperties(O.get(id));
    const tProps = ownProperties(T.get(id));

    const keys = new Set(
      Object.keys(bProps).concat(Object.keys(oProps), Object.keys(tProps))
    );

    const auto = [];
    const clash = [];

    keys.forEach(key => {
      const b = bProps[key];
      const o = oProps[key];
      const t = tProps[key];

      // The sides agree - whether neither changed it or both changed it the
      // same way. Nothing to reconcile either way.
      if (o === t) {
        return;
      }

      // Exactly one side moved off the ancestor: take that side, silently.
      if (o === b) {
        auto.push({ key, label: labelFor(key), side: 'theirs', from: nz(b), to: nz(t) });
        return;
      }

      if (t === b) {
        auto.push({ key, label: labelFor(key), side: 'ours', from: nz(b), to: nz(o) });
        return;
      }

      // Both moved, and to different values. This is the row a person has
      // to decide.
      clash.push({ key, label: labelFor(key), base: nz(b), ours: nz(o), theirs: nz(t) });
    });

    if (clash.length) {
      clash.sort((x, y) => x.label.localeCompare(y.label));
      conflicts.push(Object.assign(describe(O.get(id)), { kind: 'property', changes: clash }));
    } else if (auto.length) {
      auto.sort((x, y) => x.label.localeCompare(y.label));
      clean.push(Object.assign(describe(O.get(id)), { kind: 'change', changes: auto }));
    }
    // Otherwise identical across all three: nothing to report.
  });

  const order = (x, y) => String(x.name || x.id).localeCompare(String(y.name || y.id));

  clean.sort(order);
  conflicts.sort(order);

  return {
    mergeable: true,
    clean,
    conflicts,
    summary: {
      auto: clean.length,
      conflicts: conflicts.length,

      // The headline the panel leads with, and the whole point of Phase 1:
      // work that combines on its own without anyone having to choose.
      combinesCleanly: conflicts.length === 0 && clean.length > 0
    }
  };
}

module.exports = {
  compare,
  merge,
  indexElements,
  ownProperties,
  labelFor,
  parse
};
