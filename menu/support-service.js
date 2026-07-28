/**
 * "Report a problem": compile everything a support conversation actually
 * needs into a mail draft, so the user sends one email instead of being
 * asked, one at a time, for their branch, their remote, and what the plugin
 * logged.
 *
 * It gathers the same context the panel can already screenshot, the recorded
 * git activity (where failures show up), a secret-free copy of the settings,
 * and the environment - writes them as files, and builds an `.eml` draft with
 * those attached. It only ever *drafts*: the caller opens it in the user's
 * mail client, and the user reviews the attachments and chooses to send. No
 * message is ever sent from here, and tokens never leave the machine.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const configStore = require('./config-store');
const commandLog = require('./command-log');
const contextService = require('./context-service');

const pkg = require('../package.json');

const SECRET_KEYS = [ 'githubToken', 'gitlabToken', 'openRouterKey' ];

function redactConfig(config) {
  const clone = Object.assign({}, config);

  SECRET_KEYS.forEach(key => {
    if (clone[key]) clone[key] = '<redacted>';
  });

  return clone;
}

function line(label, value) {
  return `${label}: ${value === undefined || value === null || value === '' ? '(not set)' : value}`;
}

function summaryText(ctx, ctxError) {
  const lines = [ `Camunda Git Plugin ${pkg.version} - problem report`, '' ];

  if (ctxError) {
    lines.push(`Context unavailable: ${ctxError}`);
    return lines.join('\n');
  }

  lines.push('# Project');
  lines.push(line('Folder', ctx.repo.path));
  lines.push(line('Configured layout', ctx.project && ctx.project.configured ? 'yes' : 'guessed'));
  lines.push('');

  lines.push('# Workstream');
  lines.push(line('Branch', ctx.branch.current));
  lines.push(line('Reads as', ctx.branch.title));
  lines.push(line('Upstream', ctx.branch.upstream));
  lines.push(line('Ahead / behind', `${ctx.branch.ahead} / ${ctx.branch.behind}`));
  lines.push(line('Detached', ctx.branch.detached ? 'yes' : 'no'));
  lines.push('');

  lines.push('# Identity');
  lines.push(line('Name', ctx.identity && ctx.identity.name));
  lines.push(line('Email', ctx.identity && ctx.identity.email));
  lines.push('');

  lines.push('# Server');
  lines.push(line('Remote', ctx.remote && ctx.remote.url));
  lines.push(line('Host', ctx.remote && ctx.remote.host));
  lines.push('');

  lines.push('# Last save point');
  if (ctx.head && ctx.head.short) {
    lines.push(line('Commit', `${ctx.head.short} ${ctx.head.subject || ''}`));
    lines.push(line('By', ctx.head.author));
    lines.push(line('When', ctx.head.date));
  } else {
    lines.push('(no commits yet)');
  }
  lines.push('');

  lines.push('# Working state');
  lines.push(line('Changed files', ctx.work.changed));
  lines.push(line('Staged', ctx.work.staged));
  lines.push(line('Conflicted', ctx.work.conflicted));
  lines.push(line('Clean', ctx.work.clean ? 'yes' : 'no'));

  return lines.join('\n');
}

function environmentText() {
  return [
    `Plugin version: ${pkg.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    `OS release: ${os.release()}`,
    `Node: ${process.versions.node}`,
    `Electron: ${process.versions.electron || '(unknown)'}`,
    `Chrome: ${process.versions.chrome || '(unknown)'}`,
    `Generated: ${new Date().toISOString()}`
  ].join('\n');
}

function activityText(entries) {
  if (!entries.length) {
    return 'No git activity recorded this session.';
  }

  return entries.map(e => {
    const when = new Date(e.at).toISOString();
    // `command` is already a formatted string, recorded at call time.
    const head = `[${when}] (${e.origin}) ${e.command} -> ${e.ok ? 'ok' : 'FAILED'} in ${e.durationMs}ms`;

    // A failure's message is the point of the whole log; keep it inline.
    return e.ok ? head : `${head}\n    ${e.error || ''}`;
  }).join('\n');
}

// Fold base64 to 76-char lines, as MIME wants.
function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function attachmentPart(boundary, name, content) {
  return `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8; name="${name}"\r\n` +
    `Content-Disposition: attachment; filename="${name}"\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    `${base64(content)}\r\n`;
}

function buildEml(files) {
  const boundary = `cgp-${Date.now()}`;

  const body = [
    'Describe the problem here: what you were doing, and what went wrong.',
    '',
    'The plugin has attached a summary, your recent git activity, the',
    'environment, and a secret-free copy of your settings. Please review the',
    'attachments and remove anything you do not want to share before sending.',
    '',
    '--- summary ---',
    '',
    files.find(f => f.name === 'summary.txt').content
  ].join('\r\n');

  let eml = '';
  eml += 'To: \r\n';
  eml += 'Subject: Camunda Git Plugin - problem report\r\n';
  eml += 'X-Unsent: 1\r\n';   // tells Outlook to open as a draft to edit and send
  eml += 'MIME-Version: 1.0\r\n';
  eml += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  eml += `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

  files.forEach(f => { eml += attachmentPart(boundary, f.name, f.content); });

  eml += `--${boundary}--\r\n`;

  return eml;
}

/**
 * Build the bundle on disk and return where it is. Never sends anything.
 */
async function buildReport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-git-support-'));

  let ctx = null;
  let ctxError = null;

  try {
    ctx = await contextService.get();
  } catch (err) {
    ctxError = err.message;
  }

  let config = {};
  try {
    config = redactConfig(configStore.readConfig());
  } catch (err) {
    config = { error: err.message };
  }

  const files = [
    { name: 'summary.txt', content: summaryText(ctx, ctxError) },
    { name: 'environment.txt', content: environmentText() },
    { name: 'activity.log', content: activityText(commandLog.list({ limit: 200 })) },
    { name: 'settings.json', content: JSON.stringify(config, null, 2) }
  ];

  files.forEach(f => fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8'));

  const emlPath = path.join(dir, 'problem-report.eml');
  fs.writeFileSync(emlPath, buildEml(files), 'utf8');

  return {
    dir,
    emlPath,
    files: files.map(f => f.name)
  };
}

module.exports = {
  buildReport,
  redactConfig,
  summaryText,
  activityText
};
