/**
 * Tests for the support report, focused on the two things that matter most:
 * secrets never leave the machine, and the .eml is a real draft with the
 * logs attached. The full build writes to a temp dir and needs a repo for
 * context, so that is exercised by hand; these cover the pure parts.
 *
 * Plain `node test/support.test.js`.
 */

'use strict';

const assert = require('assert');
const { redactConfig, activityText } = require('../menu/support-service');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

test('redactConfig hides tokens and the OpenRouter key', () => {
  const out = redactConfig({
    repoPath: '/x', githubToken: 'ghp_secret', gitlabToken: 'glpat_secret',
    openRouterKey: 'sk-or-secret', openRouterModel: 'anthropic/claude-sonnet-4.5'
  });

  assert.strictEqual(out.githubToken, '<redacted>');
  assert.strictEqual(out.gitlabToken, '<redacted>');
  assert.strictEqual(out.openRouterKey, '<redacted>');
  // Non-secret values are kept.
  assert.strictEqual(out.repoPath, '/x');
  assert.strictEqual(out.openRouterModel, 'anthropic/claude-sonnet-4.5');
});

test('redactConfig leaves absent secrets absent (does not invent them)', () => {
  const out = redactConfig({ repoPath: '/x' });
  assert.ok(!('githubToken' in out));
});

test('redactConfig does not mutate the input', () => {
  const input = { githubToken: 'ghp_secret' };
  redactConfig(input);
  assert.strictEqual(input.githubToken, 'ghp_secret');
});

test('activityText surfaces a failure with its message', () => {
  const text = activityText([
    { at: Date.now(), origin: 'user', command: 'git push', ok: false, durationMs: 12, error: 'rejected: non-fast-forward' }
  ]);
  assert.ok(/FAILED/.test(text));
  assert.ok(/non-fast-forward/.test(text));
});

test('activityText handles an empty log without throwing', () => {
  assert.ok(/No git activity/.test(activityText([])));
});

const failed = results.filter(r => !r.ok);
results.forEach(r => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok) console.log(`     ${r.err.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
