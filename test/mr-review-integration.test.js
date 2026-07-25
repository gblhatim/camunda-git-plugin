/**
 * End-to-end test of the git mechanic behind reviewing a merge request.
 *
 * `merge-request-service.reviewChanges` / `reviewFile` resolve the two
 * branches, take their merge base, and diff base..source - the three-dot
 * diff a host's "Files changed" shows. The property that matters, and the
 * one that is easy to get wrong, is that the *target's own* later commits do
 * not leak into the list: a review shows what the request adds, not what
 * happened on the target since it branched. This drives the same commands
 * against a real bare remote and checks exactly that, plus the before/after
 * extraction for one file.
 *
 * Plain `node test/mr-review-integration.test.js`; skips if git is absent.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const doc = (id, inner) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="x">
  <bpmn:process id="${id}">${inner}</bpmn:process>
</bpmn:definitions>
`;

// A single-task process, for the file that gets edited.
const task = name => doc('A', `<bpmn:task id="A_t" name="${name}" />`);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] });
}

function config(dir) {
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

// The two functions under test, inlined against a given repo dir so the test
// needs no configured plugin repo.
function changedFiles(repo, base, sourceRef) {
  return git(repo, 'diff', '--name-status', '-M', base, sourceRef)
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => {
      const c = l.split('\t');
      const letter = c[0].charAt(0).toUpperCase();
      const rename = letter === 'R' || letter === 'C';
      return { status: letter, path: rename ? c[2] : c[1] };
    });
}

async function run() {
  try {
    git(os.tmpdir(), '--version');
  } catch (err) {
    console.log('ok   (skipped - git not available)');
    console.log('\n1/1 passed');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-review-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    config(work);

    const write = (name, body) => fs.writeFileSync(path.join(work, name), body);

    // Base on main: a.bpmn (edited later) and b.bpmn (deleted later).
    // b and c are deliberately dissimilar so `-M` cannot misread the
    // delete-plus-add as a rename.
    write('a.bpmn', task('One'));
    write('b.bpmn', doc('BBB',
      '<bpmn:startEvent id="b_s"/><bpmn:userTask id="b_u" name="Approve invoice"/>' +
      '<bpmn:serviceTask id="b_v" name="Charge card"/><bpmn:endEvent id="b_e"/>'));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'push', '-q', 'origin', 'main');

    // The request's source branch: edit a, add c, delete b.
    git(work, 'checkout', '-q', '-b', 'feature');
    write('a.bpmn', task('Two'));
    write('c.bpmn', doc('CCC', '<bpmn:manualTask id="c_m" name="File the paperwork"/>'));
    fs.rmSync(path.join(work, 'b.bpmn'));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'the request');
    git(work, 'push', '-q', '-u', 'origin', 'feature');

    // The TARGET moves on independently after the branch point: a new file
    // that has nothing to do with the request.
    git(work, 'checkout', '-q', 'main');
    write('unrelated.bpmn', doc('UUU', '<bpmn:task id="u_t" name="Target only"/>'));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'target advances');
    git(work, 'push', '-q', 'origin', 'main');

    // ---- reviewChanges, from a fresh clone ----
    const dev = path.join(root, 'dev');
    git(root, 'clone', '-q', origin, dev);
    config(dev);
    git(dev, 'fetch', '-q', 'origin');

    const base = git(dev, 'merge-base', 'origin/main', 'origin/feature').trim();
    const files = changedFiles(dev, base, 'origin/feature');
    const byPath = Object.fromEntries(files.map(f => [ f.path, f.status ]));

    assert.strictEqual(byPath['a.bpmn'], 'M', 'a.bpmn is edited');
    assert.strictEqual(byPath['c.bpmn'], 'A', 'c.bpmn is added');
    assert.strictEqual(byPath['b.bpmn'], 'D', 'b.bpmn is deleted');
    assert.ok(!('unrelated.bpmn' in byPath),
      "the target's own later file must not appear in the request's changes");

    // ---- reviewFile a.bpmn: before/after come from base and source ----
    const before = git(dev, 'show', `${base}:a.bpmn`);
    const after = git(dev, 'show', 'origin/feature:a.bpmn');

    assert.ok(/name="One"/.test(before), 'before is the base version');
    assert.ok(/name="Two"/.test(after), 'after is the source version');

    console.log('ok   a merge request review lists its own changes, before and after');
    console.log('\n1/1 passed');
  } catch (err) {
    console.log('FAIL a merge request review lists its own changes, before and after');
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
