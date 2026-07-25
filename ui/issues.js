'use strict';

const $ = id => document.getElementById(id);

async function load() {
  $('message').textContent = 'Loading issues...';
  try {
    const data = await window.gitPlugin.invoke('get');
    $('title').textContent = data.kind === 'github' ? 'GitHub Open Issues' : 'GitLab Open Issues';
    $('sub').textContent = data.repoPath || '';
    $('message').textContent = '';

    const rows = $('rows');
    rows.innerHTML = '';

    if (!data.issues.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4">No open issues.</td>';
      rows.appendChild(tr);
      return;
    }

    data.issues.forEach(issue => {
      const tr = document.createElement('tr');

      const numberTd = document.createElement('td');
      numberTd.textContent = `#${issue.number}`;

      const titleTd = document.createElement('td');
      const link = document.createElement('a');
      link.textContent = issue.title;
      link.href = '#';
      link.addEventListener('click', evt => {
        evt.preventDefault();
        window.gitPlugin.invoke('openExternal', issue.url);
      });
      titleTd.appendChild(link);

      const authorTd = document.createElement('td');
      authorTd.textContent = issue.author || '-';

      const dateTd = document.createElement('td');
      dateTd.textContent = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString() : '-';

      tr.appendChild(numberTd);
      tr.appendChild(titleTd);
      tr.appendChild(authorTd);
      tr.appendChild(dateTd);
      rows.appendChild(tr);
    });
  } catch (err) {
    $('message').textContent = '';
    $('error').textContent = err.message || String(err);
  }
}

load();
