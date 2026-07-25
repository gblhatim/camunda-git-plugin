'use strict';

const $ = id => document.getElementById(id);

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderDiff(el, text) {
  if (!text) {
    el.textContent = '(no changes)';
    return;
  }
  el.innerHTML = text
    .split('\n')
    .map(line => {
      const escaped = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-add">${escaped}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-del">${escaped}</span>`;
      }
      return escaped;
    })
    .join('\n');
}

function renderFiles(status) {
  const list = $('files');
  list.innerHTML = '';

  const groups = [
    { files: status.modified, code: 'M', cls: 'status-M' },
    { files: status.created, code: 'A', cls: 'status-A' },
    { files: status.deleted, code: 'D', cls: 'status-D' },
    { files: status.not_added, code: '?', cls: 'status-untracked' },
    { files: status.renamed ? status.renamed.map(r => r.to) : [], code: 'R', cls: 'status-M' }
  ];

  let any = false;
  groups.forEach(group => {
    (group.files || []).forEach(file => {
      any = true;
      const li = document.createElement('li');
      li.className = group.cls;
      li.textContent = `[${group.code}] ${file}`;
      list.appendChild(li);
    });
  });

  if (!any) {
    const li = document.createElement('li');
    li.textContent = 'Working tree clean.';
    list.appendChild(li);
  }
}

async function refresh() {
  $('error').textContent = '';
  $('message').textContent = 'Loading...';

  try {
    const data = await window.gitPlugin.invoke('get');
    $('repoPath').textContent = data.repoPath || '(no repository configured)';
    $('branch').textContent = data.branch || '(unknown)';
    renderFiles(data.status);
    renderDiff($('unstagedDiff'), data.unstaged);
    renderDiff($('stagedDiff'), data.staged);
    $('message').textContent = '';
  } catch (err) {
    $('message').textContent = '';
    $('error').textContent = err.message || String(err);
  }
}

$('refresh').addEventListener('click', refresh);

$('push').addEventListener('click', async () => {
  $('message').textContent = 'Pushing...';
  try {
    await window.gitPlugin.invoke('push');
    $('message').textContent = 'Push complete.';
    refresh();
  } catch (err) {
    $('error').textContent = err.message || String(err);
  }
});

$('pull').addEventListener('click', async () => {
  $('message').textContent = 'Pulling...';
  try {
    await window.gitPlugin.invoke('pull');
    $('message').textContent = 'Pull complete.';
    refresh();
  } catch (err) {
    $('error').textContent = err.message || String(err);
  }
});

$('commit').addEventListener('click', async () => {
  const message = $('commitMessage').value.trim();
  if (!message) {
    $('error').textContent = 'Enter a commit message first.';
    return;
  }
  $('message').textContent = 'Committing...';
  try {
    await window.gitPlugin.invoke('commit', message);
    $('commitMessage').value = '';
    $('message').textContent = 'Committed.';
    refresh();
  } catch (err) {
    $('error').textContent = err.message || String(err);
  }
});

refresh();
