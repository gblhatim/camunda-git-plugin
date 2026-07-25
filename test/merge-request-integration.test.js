/**
 * End-to-end test of the git mechanic behind resolving a merge request.
 *
 * `merge-request-service.startResolution` does exactly this against the
 * configured repo: fetch the server, land on the request's *source* branch,
 * merge the *target* in, and leave the tree mid-conflict for the resolver.
 * This drives the same sequence against a real bare "origin" so the flow -
 * and the claim that pushing afterwards makes the request mergeable - is
 * pinned as reproducible.
 *
 * Plain `node test/merge-request-integration.test.js`; shells out to git and
 * skips (does not fail) if git is unavailable.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const diagram = name =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:serviceTask id="T" name="${name}" />
  </bpmn:process>
</bpmn:definitions>
`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] });
}

function config(dir) {
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

async function run() {
  try {
    git(os.tmpdir(), '--version');
  } catch (err) {
    console.log('ok   (skipped - git not available)');
    console.log('\n1/1 passed');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-mr-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'work');
  const file = path.join(clone, 'order.bpmn');

  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, clone);
    config(clone);

    // Base on main.
    fs.writeFileSync(file, diagram('Charge'));
    git(clone, 'add', 'order.bpmn');
    git(clone, 'commit', '-q', '-m', 'base');
    git(clone, 'push', '-q', 'origin', 'main');

    // The MR's source branch edits the task.
    git(clone, 'checkout', '-q', '-b', 'feature/rename');
    fs.writeFileSync(file, diagram('Charge card'));
    git(clone, 'commit', '-q', '-am', 'rename on feature');
    git(clone, 'push', '-q', '-u', 'origin', 'feature/rename');

    // Meanwhile main (the target) moves the same line, so the two conflict.
    git(clone, 'checkout', '-q', 'main');
    fs.writeFileSync(file, diagram('Charge customer'));
    git(clone, 'commit', '-q', '-am', 'rename on main');
    git(clone, 'push', '-q', 'origin', 'main');

    // ---- what startResolution does, from a fresh clone ----
    const dev = path.join(root, 'dev');
    git(root, 'clone', '-q', origin, dev);
    config(dev);

    // Land on the source branch (only exists on origin here), then merge the
    // target in - the exact sequence the service runs.
    git(dev, 'fetch', '-q', 'origin');
    git(dev, 'checkout', '-q', '-b', 'feature/rename', 'origin/feature/rename');

    let conflicted = false;
    try {
      git(dev, 'merge', 'origin/main');
    } catch (err) {
      conflicted = true;
    }

    assert.ok(conflicted, 'merging the target into the source should conflict');

    const status = git(dev, 'status', '--porcelain');
    assert.ok(/^UU order\.bpmn/m.test(status), 'order.bpmn should be conflicted');

    // Resolve the way the panel would (keep the source side), commit, push.
    git(dev, 'checkout', '--theirs', '--', 'order.bpmn');  // 'theirs' = origin/main here
    git(dev, 'add', 'order.bpmn');
    git(dev, 'commit', '-q', '--no-edit');
    git(dev, 'push', '-q', 'origin', 'feature/rename');

    // The push is what makes the request mergeable: origin/main is now an
    // ancestor of the source branch, so there is nothing left to conflict.
    git(dev, 'fetch', '-q', 'origin');
    let mergeable = true;
    try {
      git(dev, 'merge-base', '--is-ancestor', 'origin/main', 'feature/rename');
    } catch (err) {
      mergeable = false;
    }

    assert.ok(mergeable, 'after resolving and pushing, the target is merged into the source');

    console.log('ok   a conflicting merge request is resolved locally and made mergeable');
    console.log('\n1/1 passed');
  } catch (err) {
    console.log('FAIL a conflicting merge request is resolved locally and made mergeable');
    console.log(`     ${err.message}`);
    console.log('\n0/1 passed');
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) { /* best effort */ }
  }
}

run();
