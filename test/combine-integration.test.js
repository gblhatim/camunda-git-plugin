/**
 * End-to-end test of combining a *real* merge conflict.
 *
 * The unit tests drive `mergeXml` with three XML strings; this drives the
 * whole mechanic the plugin actually uses: a genuine `git merge` that
 * conflicts, the three index stages read back with `git show :1:/:2:/:3:`,
 * the merged document written into the working tree, and `git add` staging
 * it - after which git must consider the conflict resolved.
 *
 * This is the reproducible merge-conflict scenario the feature exists for,
 * kept as a test so it cannot quietly stop being reproducible. Plain
 * `node test/combine-integration.test.js`; it shells out to `git`, and
 * skips (does not fail) if git is unavailable.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { mergeXml, parse, indexElements, ownProperties } = require('../menu/diagram-diff-service');

// One service task on its own line, so that two different edits to it are a
// genuine line-level conflict git cannot auto-resolve - while being exactly
// the "each side changed a different property" case that combines cleanly.
const diagram = (name, async) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:serviceTask id="T" name="${name}" camunda:asyncBefore="${async}" camunda:delegateExpression="\${adapter}" />
  </bpmn:process>
</bpmn:definitions>
`;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: [ 'pipe', 'pipe', 'pipe' ]
  });
}

async function propsOf(xml, id) {
  const el = indexElements(await parse(xml)).get(id);
  return el ? ownProperties(el) : null;
}

async function run() {
  let repo;

  try {
    git(os.tmpdir(), '--version');
  } catch (err) {
    console.log('ok   (skipped - git not available)');
    console.log('\n1/1 passed');
    return;
  }

  try {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-combine-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@local');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    const file = path.join(repo, 'order.bpmn');

    // Base: the ancestor both sides start from.
    fs.writeFileSync(file, diagram('Charge', 'false'));
    git(repo, 'add', 'order.bpmn');
    git(repo, 'commit', '-q', '-m', 'base');

    // Theirs: change the async flag, on their own branch.
    git(repo, 'checkout', '-q', '-b', 'theirs');
    fs.writeFileSync(file, diagram('Charge', 'true'));
    git(repo, 'commit', '-q', '-am', 'theirs: async before');

    // Ours: rename the task, on main - the same line, so it conflicts.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(file, diagram('Charge card', 'false'));
    git(repo, 'commit', '-q', '-am', 'ours: rename');

    // The merge that conflicts.
    let conflicted = false;
    try {
      git(repo, 'merge', '--no-edit', 'theirs');
    } catch (err) {
      conflicted = true;
    }
    assert.ok(conflicted, 'the merge should conflict on order.bpmn');

    // Read the three stages exactly as conflict-service does.
    const base = git(repo, 'show', ':1:order.bpmn');
    const ours = git(repo, 'show', ':2:order.bpmn');
    const theirs = git(repo, 'show', ':3:order.bpmn');

    const result = await mergeXml(base, ours, theirs);
    assert.strictEqual(result.combinable, true, result.reason);

    // Resolve the way combineFile does: write the union, stage it.
    fs.writeFileSync(file, result.xml);
    git(repo, 'add', 'order.bpmn');

    // Git must now see nothing conflicted.
    const status = git(repo, 'status', '--porcelain');
    assert.ok(!/^(UU|AA|DD|AU|UA|DU|UD) /m.test(status),
      `no path should still be conflicted:\n${status}`);

    // And the staged diagram must carry BOTH sides' changes.
    const staged = git(repo, 'show', ':order.bpmn');
    const props = await propsOf(staged, 'T');
    assert.strictEqual(props.name, 'Charge card', 'our rename survived');
    assert.strictEqual(props['@camunda:asyncBefore'], 'true', 'their async flag survived');

    // The commit completes without a conflict left behind.
    git(repo, 'commit', '-q', '--no-edit');

    console.log('ok   a real git conflict is combined and resolved end to end');
    console.log('\n1/1 passed');
  } catch (err) {
    console.log('FAIL a real git conflict is combined and resolved end to end');
    console.log(`     ${err.message}`);
    console.log('\n0/1 passed');
    process.exitCode = 1;
  } finally {
    if (repo) {
      try {
        fs.rmSync(repo, { recursive: true, force: true });
      } catch (err) { /* best effort */ }
    }
  }
}

run();
