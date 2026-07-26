/**
 * Presentational pieces for both panels.
 *
 * Split out of index.js, which had grown to hold the bridge plumbing, the
 * state machine and every view at once. Everything here is stateless apart
 * from local UI state (which folder is open, what is typed in a box).
 *
 * Styling lives in styles.css - these components only pick class names.
 */

import React from 'camunda-modeler-plugin-helpers/vendor/react.js';

import { Icon } from './icons.js';

const { useState, useEffect, useRef } = React;

const h = React.createElement;

// --------------------------------------------------------------- helpers

const DIAGRAM_EXT = /\.(bpmn|dmn|form|xml)$/i;

export function prettyName(fileName) {
  return String(fileName).replace(DIAGRAM_EXT, '');
}

export function timeAgo(iso) {
  if (!iso) {
    return '';
  }

  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

/** Git porcelain letters, in words. */
const STATUS_WORDS = {
  M: [ 'Edited', 'edited' ],
  A: [ 'Added', 'added' ],
  D: [ 'Deleted', 'deleted' ],
  R: [ 'Renamed', 'info' ],
  C: [ 'Copied', 'info' ],
  U: [ 'Conflict', 'deleted' ],
  '?': [ 'New', 'added' ]
};

export function statusWord(file) {
  const code = file.index !== ' ' ? file.index : file.working_dir;
  const [ word, tone ] = STATUS_WORDS[code] || [ 'Changed', 'muted' ];

  return { word, tone, code };
}

// ---------------------------------------------------------------- notice

// ------------------------------------------------------------ busy states

/**
 * What is happening right now, while it is happening.
 *
 * Until this existed the only sign that git was running was the whole panel
 * fading out (`.cgp-busy` is opacity plus pointer-events: none). That reads
 * as "broken" rather than "working", and it is worst exactly where it
 * matters most: a first push, a clone, or a pull over a VPN can sit there
 * for thirty seconds with nothing moving and no way to tell a slow network
 * from a hang.
 *
 * So this says three things - that something is running, *what* it is in
 * the same plain language as the button that started it, and how long it
 * has been going. The elapsed count only appears once the operation is slow
 * enough to be worth worrying about; showing "0s" immediately would make
 * every fast action feel sluggish.
 */
export function BusyBar({ pending }) {
  const [ elapsed, setElapsed ] = useState(0);

  const startedAt = pending && pending.startedAt;

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return undefined;
    }

    // Tick rather than compute once: the whole point is that the reader can
    // see it moving and know nothing is wedged.
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500
    );

    return () => clearInterval(id);
  }, [ startedAt ]);

  if (!pending) {
    return null;
  }

  return h('div', { className: 'cgp-busybar', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'cgp-spinner', 'aria-hidden': 'true' }),
    h('span', { className: 'cgp-busybar__label' },
      pending.label || 'Working'
    ),
    elapsed >= 3 && h('span', { className: 'cgp-busybar__elapsed' }, `${elapsed}s`),

    // Ten seconds is about where "it is being slow" turns into "is it
    // stuck?". Saying which of the two it is costs one line.
    elapsed >= 10 && h('span', { className: 'cgp-busybar__hint' },
      pending.slow || 'Still going - large projects and slow connections take a while.'
    )
  );
}

export function Notice({ notice, busy, onFix }) {
  if (!notice) {
    return null;
  }

  const kind = notice.type === 'error' ? 'error'
    : notice.type === 'warn' ? 'warn' : 'success';

  return h('div', { className: `cgp-notice cgp-notice--${kind}` },
    h('div', { className: 'cgp-notice__title' }, notice.text),

    notice.detail && h('div', { className: 'cgp-notice__body' }, notice.detail),

    notice.fix && h('div', { style: { marginTop: '8px' } },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: busy,
        title: notice.fix.note,
        onClick: () => onFix(notice.fix.id)
      }, notice.fix.label),
      notice.fix.note && h('div', { className: 'cgp-notice__body' }, notice.fix.note)
    ),

    notice.raw && notice.recognised === false && h('details', { style: { marginTop: '6px' } },
      h('summary', { style: { cursor: 'pointer', fontSize: '11px' } }, 'Technical details'),
      h('pre', { className: 'cgp-notice__raw' }, notice.raw)
    )
  );
}

// ----------------------------------------------------------- workstreams

/**
 * A ticket, as a link when we know where Jira lives and as plain text when
 * we do not. A dead link is worse than none.
 */
function Ticket({ stream }) {
  if (!stream.ticket) {
    return null;
  }

  if (!stream.ticketUrl) {
    return h('span', { className: 'cgp-ticket' }, stream.ticket);
  }

  return h('a', {
    className: 'cgp-ticket cgp-ticket--link',
    href: stream.ticketUrl,
    target: '_blank',
    rel: 'noreferrer',
    title: `Open ${stream.ticket}`
  }, stream.ticket);
}

// The kind of work a branch is, as a small colour-coded pill. Labels are
// deliberately shorter than the create form's ("New" vs "New work") because
// here they sit inline next to a name and earn their place by being glanceable.
const TYPE_META = {
  feature: { label: 'New', cls: 'feature', title: 'New work' },
  bugfix:  { label: 'Fix', cls: 'bugfix', title: 'A fix' },
  hotfix:  { label: 'Urgent', cls: 'hotfix', title: 'An urgent fix to what is live' }
};

function TypePill({ type }) {
  const meta = TYPE_META[type];

  if (!meta) {
    return null;
  }

  return h('span', {
    className: `cgp-typepill cgp-typepill--${meta.cls}`,
    title: meta.title
  }, meta.label);
}

/**
 * Confirming a removal, with the consequences stated rather than implied.
 *
 * The three outcomes from `planDeleteWorkstream` are genuinely different and
 * are shown as such. "Already in the shared version" is a tidy-up and reads
 * like one; "this exists nowhere else" is a warning and reads like one. A
 * single "Are you sure?" for both is what teaches people to click through
 * warnings without reading them.
 *
 * Removing it from the server is a separate, unticked box, because that is
 * a different act with a different blast radius: everyone loses it, not
 * just this computer.
 */
function RemoveWorkstream({ stream, plan, busy, onCancel, onConfirm }) {
  const [ alsoOnServer, setAlsoOnServer ] = useState(false);

  if (!plan) {
    return h('div', { className: 'cgp-block cgp-block--nested' },
      h('p', { className: 'cgp-sub' }, `Checking "${stream.title}"...`)
    );
  }

  if (!plan.possible) {
    return h('div', { className: 'cgp-block cgp-block--nested' },
      h('p', { className: 'cgp-empty' }, plan.reason),
      h('button', { className: 'btn cgp-btn', onClick: onCancel }, 'Close')
    );
  }

  const unmerged = plan.safety === 'unmerged';

  return h('div', { className: 'cgp-block cgp-block--nested' },
    h('p', { className: 'cgp-block__title' }, `Remove "${plan.title}"?`),

    h('div', {
      className: `cgp-notice cgp-notice--${unmerged ? 'warn' : 'success'}`
    }, plan.detail),

    plan.isCurrent && h('p', { className: 'cgp-sub' },
      `This is what you are working on right now, so you will be moved to ` +
      `"${plan.base}" first.`
    ),

    plan.onServer && h('label', { className: 'cgp-check' },
      h('input', {
        type: 'checkbox',
        checked: alsoOnServer,
        disabled: busy,
        onChange: e => setAlsoOnServer(e.target.checked)
      }),
      ' Also remove it from the team server (this affects everyone)'
    ),

    h('div', { className: 'cgp-field' },
      h('button', {
        className: `btn cgp-btn ${unmerged ? '' : 'cgp-btn--primary'}`,
        disabled: busy,
        onClick: () => onConfirm({ alsoOnServer, force: unmerged })
      }, unmerged ? 'Remove it anyway' : 'Remove it'),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: onCancel
      }, 'Cancel')
    )
  );
}

export function Workstreams({ workstreams, actions, busy }) {
  const [ newName, setNewName ] = useState('');
  const [ type, setType ] = useState('feature');
  const [ ticket, setTicket ] = useState('');
  const [ creating, setCreating ] = useState(false);
  const [ removing, setRemoving ] = useState(null);
  const [ removePlan, setRemovePlan ] = useState(null);

  if (!workstreams) {
    return null;
  }

  const streams = workstreams.streams || [];
  const current = streams.find(s => s.isCurrent);
  const others = streams.filter(s => !s.isCurrent);

  // The rules come from the main process rather than being restated here,
  // so what the form enforces cannot drift from what the branch name gets.
  const naming = workstreams.naming;
  const types = (naming && naming.types) || [];
  const chosen = types.find(t => t.id === type) || types[0];
  const projectKey = (naming && naming.projectKey) || 'BDM';

  // Untyped creation stays available for a project nobody has set up yet.
  const typed = types.length > 0;
  const ticketMissing = typed && chosen && chosen.ticketRequired && !ticket.trim();
  const canStart = !!newName.trim() && !ticketMissing;

  const reset = () => {
    setNewName('');
    setTicket('');
    setCreating(false);
  };

  const onRemove = async s => {
    setRemoving(s);
    setRemovePlan(null);
    setRemovePlan(await actions.previewRemoveWorkstream(s.name));
  };

  const cancelRemove = () => {
    setRemoving(null);
    setRemovePlan(null);
  };

  const confirmRemove = async opts => {
    await actions.removeWorkstream(removing.name, opts);
    cancelRemove();
  };

  const start = () => {
    if (!canStart) return;

    actions.createWorkstream(typed
      ? { type: chosen.id, ticket: ticket.trim(), title: newName.trim() }
      : { title: newName.trim() });

    reset();
  };

  return h('div', { className: 'cgp-block' },
    current && h('div', null,
      h('p', { className: 'cgp-eyebrow' }, "You're working on"),
      h('p', { className: 'cgp-headline', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h(TypePill, { type: current.type }),
        h('span', null, current.title + (current.isMain ? ' (shared version)' : ''))
      ),
      current.ticketUrl && h('p', { style: { margin: '0 0 4px' } },
        h(Ticket, { stream: current })
      ),
      h('p', { className: 'cgp-sub' }, [
        current.lastChange ? `last changed ${timeAgo(current.lastChange)}` : null,
        current.localOnly ? 'not on the server yet' : null
      ].filter(Boolean).join(' · '))
    ),

    others.length > 0 && h('details', { style: { margin: '10px 0 8px' } },
      h('summary', { style: { cursor: 'pointer', fontSize: '12px' } },
        `Switch to something else (${others.length})`
      ),
      h('ul', { className: 'cgp-list', style: { marginTop: '6px' } },
        others.map(s => h('li', { key: s.name, className: 'cgp-row' },
          h(TypePill, { type: s.type }),
          h('span', { className: 'cgp-row__name' },
            s.title, s.isMain && h('span', { className: 'cgp-row__meta' }, '  (shared version)')
          ),
          s.onServer && h('span', {
            className: 'cgp-row__meta',
            title: 'On the team server'
          }, h(Icon, { name: 'Branch', size: 11 })),
          h('span', { className: 'cgp-row__meta' },
            [ s.lastAuthor, timeAgo(s.lastChange) ].filter(Boolean).join(', ')
          ),
          h('span', { className: 'cgp-row__actions' },
            h('button', {
              className: 'btn cgp-btn',
              disabled: busy,
              title: 'Your current work is saved automatically before switching',
              onClick: () => actions.switchWorkstream(s.name)
            }, 'Switch'),

            // The shared branches are not workstreams and have no remove
            // button at all - offering one that always refuses is worse
            // than not offering it.
            !s.isMain && !s.isRelease && h('button', {
              className: 'btn cgp-btn cgp-btn--quiet',
              disabled: busy,
              title: `Remove "${s.title}" from this computer`,
              onClick: () => onRemove(s)
            }, 'Remove')
          )
        ))
      )
    ),

    removing && h(RemoveWorkstream, {
      stream: removing,
      plan: removePlan,
      busy,
      onCancel: cancelRemove,
      onConfirm: confirmRemove
    }),

    creating
      ? h('div', { className: 'cgp-create' },

        typed && h('div', { className: 'cgp-create__types' },
          types.map(t => h('label', {
            key: t.id,
            className: `cgp-chip ${t.id === type ? 'cgp-chip--on' : ''}`,
            title: `${t.hint}. Starts from ${t.startsFrom}.`
          },
            h('input', {
              type: 'radio',
              name: 'cgp-work-type',
              checked: t.id === type,
              disabled: busy,
              onChange: () => setType(t.id)
            }),
            t.label
          ))
        ),

        h('div', { className: 'cgp-field' },
          h('input', {
            type: 'text',
            className: 'cgp-input',
            value: newName,
            placeholder: 'What are you working on?',
            disabled: busy,
            autoFocus: true,
            onChange: e => setNewName(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Enter') start();
              if (e.key === 'Escape') reset();
            }
          })
        ),

        typed && h('div', { className: 'cgp-field' },
          h('input', {
            type: 'text',
            className: 'cgp-input cgp-input--ticket',
            value: ticket,
            disabled: busy,
            placeholder: chosen && chosen.ticketRequired
              ? `${projectKey}-123456 (required)`
              : `${projectKey}-123456 (optional)`,
            onChange: e => setTicket(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Enter') start();
              if (e.key === 'Escape') reset();
            }
          })
        ),

        chosen && h('p', { className: 'cgp-sub' },
          `${chosen.hint}. Starts from "${chosen.startsFrom}".`,
          ticketMissing
            ? h('span', { className: 'cgp-sub--warn' },
              ` A ${projectKey} ticket is needed for this kind of work.`)
            : null
        ),

        h('div', { className: 'cgp-field' },
          h('button', {
            className: 'btn cgp-btn', disabled: busy || !canStart, onClick: start
          }, 'Start'),
          h('button', {
            className: 'btn cgp-btn', disabled: busy, onClick: reset
          }, 'Cancel')
        )
      )
      : h('button', {
        className: 'btn cgp-btn',
        disabled: busy,
        title: 'Starts from the latest shared version. Your current work is saved first.',
        onClick: () => setCreating(true)
      }, 'Start something new')
  );
}

// ------------------------------------------------------------ save my work

export function SaveMyWork({ actions, busy, disabled }) {
  const [ message, setMessage ] = useState('');
  const [ plan, setPlan ] = useState(null);
  const [ result, setResult ] = useState(null);
  const [ working, setWorking ] = useState(false);

  const locked = busy || working || disabled;

  const preview = async () => {
    setResult(null);
    setWorking(true);
    try {
      setPlan(await actions.previewSave());
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    setWorking(true);
    try {
      const res = await actions.runSave(message);
      setResult(res);
      setPlan(null);
      if (res && res.ok) setMessage('');
    } finally {
      setWorking(false);
    }
  };

  return h('div', { className: 'cgp-block' },
    h('p', { className: 'cgp-block__title' }, 'Save my work'),

    h('div', { className: 'cgp-field' },
      h('input', {
        type: 'text',
        className: 'cgp-input',
        value: message,
        placeholder: disabled ? 'Nothing has changed yet' : 'What did you change?',
        disabled: locked,
        onChange: e => setMessage(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter' && message.trim() && !locked) preview();
        }
      }),
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: locked || !message.trim(),
        onClick: preview
      }, working ? 'Working...' : 'Save my work')
    ),

    plan && h('div', { style: { marginTop: '10px' } },
      plan.possible === false
        ? h('p', { className: 'cgp-empty' }, plan.reason)
        : h('div', null,
          h('p', { className: 'cgp-sub' }, 'This will:'),
          h('ol', { className: 'cgp-plan' },
            plan.steps.map(s => h('li', { key: s.key }, s.label))
          ),
          plan.warnings.map((w, i) =>
            h('div', { key: i, className: 'cgp-notice cgp-notice--warn' }, w)
          ),
          h('div', { className: 'cgp-field' },
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary', disabled: locked, onClick: confirm
            }, 'Yes, do it'),
            h('button', {
              className: 'btn cgp-btn', disabled: locked, onClick: () => setPlan(null)
            }, 'Cancel')
          )
        )
    ),

    result && h('div', { style: { marginTop: '10px' } },
      h('ul', { className: 'cgp-steps' },
        (result.steps || []).map(s => h('li', { key: s.key },
          h('span', { className: s.ok ? 'cgp-step-ok' : 'cgp-step-fail' }, s.ok ? '✓' : '✕'),
          s.label
        ))
      ),
      h('div', {
        className: `cgp-notice ${result.partial ? 'cgp-notice--warn' : 'cgp-notice--success'}`
      }, result.summary)
    )
  );
}

/**
 * "I'm finished with this" - the other half of the routine pair.
 *
 * It had bridge routes and no UI, which meant the only way to finish a
 * workstream was to know git. Same preview-then-confirm contract as
 * SaveMyWork, and the same rule: what it is about to do is spelled out
 * before it happens, because "merge" and "review request" are not words
 * this audience should have to take on trust.
 */
export function FinishWork({ actions, busy, workstreams }) {
  const [ plan, setPlan ] = useState(null);
  const [ result, setResult ] = useState(null);
  const [ working, setWorking ] = useState(false);

  const current = (workstreams && (workstreams.streams || []).find(s => s.isCurrent)) || null;
  const onShared = !!(current && current.isMain);
  const locked = busy || working;

  const preview = async () => {
    setResult(null);
    setWorking(true);
    try {
      setPlan(await actions.previewFinish());
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    setWorking(true);
    try {
      const res = await actions.runFinish();
      setResult(res);
      setPlan(null);
    } finally {
      setWorking(false);
    }
  };

  return h('div', { className: 'cgp-block' },
    h('p', { className: 'cgp-block__title' }, "I'm finished with this"),

    onShared
      ? h('p', { className: 'cgp-sub' },
        'You are on the shared version rather than a workstream, so there ' +
        'is nothing to finish. Start something new first.')
      : h('p', { className: 'cgp-sub' },
        current
          ? `Hands "${current.title}" back to the team.`
          : 'Hands your current work back to the team.'),

    !onShared && h('div', { className: 'cgp-field' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: locked,
        onClick: preview
      }, working ? 'Working...' : "I'm finished")
    ),

    plan && h('div', { style: { marginTop: '10px' } },
      plan.possible === false
        ? h('p', { className: 'cgp-empty' }, plan.reason)
        : h('div', null,
          h('p', { className: 'cgp-sub' }, 'This will:'),
          h('ol', { className: 'cgp-plan' },
            (plan.steps || []).map(s => h('li', { key: s.key }, s.label))
          ),
          (plan.warnings || []).map((w, i) =>
            h('div', { key: i, className: 'cgp-notice cgp-notice--warn' }, w)
          ),
          h('div', { className: 'cgp-field' },
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary', disabled: locked, onClick: confirm
            }, 'Yes, do it'),
            h('button', {
              className: 'btn cgp-btn', disabled: locked, onClick: () => setPlan(null)
            }, 'Cancel')
          )
        )
    ),

    result && h('div', { style: { marginTop: '10px' } },
      h('ul', { className: 'cgp-steps' },
        (result.steps || []).map(s => h('li', { key: s.key },
          h('span', { className: s.ok ? 'cgp-step-ok' : 'cgp-step-fail' }, s.ok ? '✓' : '✕'),
          s.label
        ))
      ),
      h('div', {
        className: `cgp-notice ${result.partial || result.needsDecision
          ? 'cgp-notice--warn' : 'cgp-notice--success'}`
      }, result.summary)
    )
  );
}

// ------------------------------------------------------------------ setup

/**
 * Getting a project started.
 *
 * A checklist rather than a wizard: someone arriving halfway through -
 * a folder that is already a repo but has no commits, say - has to see
 * where they are, not be walked from step one. Only the next actionable
 * step is expanded; the rest are there for orientation.
 *
 * Completed steps stay visible and ticked. Watching the list fill in is
 * most of what makes this feel like progress rather than interrogation.
 */
/**
 * "Get in step with the team" - the round trip as one action.
 *
 * Same preview-then-confirm shape as the other routines, and it earns the
 * preview more than most: the whole value is that the steps happen in an
 * order that works, so showing the order *is* showing what it does.
 *
 * A conflict is rendered as a normal outcome rather than a failure, because
 * that is what it is - the resolver takes over from here.
 */
export function SyncWork({ actions, busy }) {
  const [ plan, setPlan ] = useState(null);
  const [ result, setResult ] = useState(null);
  const [ working, setWorking ] = useState(false);

  const locked = busy || working;

  const preview = async () => {
    setResult(null);
    setWorking(true);
    try {
      setPlan(await actions.previewSync());
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    setWorking(true);
    try {
      const res = await actions.runSync();
      setResult(res);
      setPlan(null);
    } finally {
      setWorking(false);
    }
  };

  return h('div', { className: 'cgp-block' },
    h('p', { className: 'cgp-sub' },
      'Gets whatever the team has, combines it with your work, and sends ' +
      'yours back - in that order, which is the order that works.'
    ),

    h('div', { className: 'cgp-field' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary', disabled: locked, onClick: preview
      }, working ? 'Working...' : 'Get in step with the team')
    ),

    plan && h('div', { style: { marginTop: '10px' } },
      plan.possible === false
        ? h('p', { className: 'cgp-empty' }, plan.reason)
        : h('div', null,
          h('p', { className: 'cgp-sub' }, 'This will:'),
          h('ol', { className: 'cgp-plan' },
            (plan.steps || []).map(s => h('li', { key: s.key }, s.label))
          ),
          (plan.warnings || []).map((w, i) =>
            h('div', { key: i, className: 'cgp-notice cgp-notice--warn' }, w)
          ),
          h('div', { className: 'cgp-field' },
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary', disabled: locked, onClick: confirm
            }, 'Yes, do it'),
            h('button', {
              className: 'btn cgp-btn', disabled: locked, onClick: () => setPlan(null)
            }, 'Cancel')
          )
        )
    ),

    result && h('div', { style: { marginTop: '10px' } },
      h('ul', { className: 'cgp-steps' },
        (result.steps || []).map(s => h('li', { key: s.key },
          h('span', { className: s.ok ? 'cgp-step-ok' : 'cgp-step-fail' }, s.ok ? '✓' : '✕'),
          s.label
        ))
      ),
      h('div', {
        className: 'cgp-notice cgp-notice--' +
          (result.needsDecision || result.partial ? 'warn' : 'success')
      }, result.summary)
    )
  );
}

/**
 * A section that is collapsed unless it is the thing you are here to do.
 *
 * The counterpart to NextAction: once one action leads, everything else has
 * to still be *reachable* without being present. The summary line carries
 * the number that would have made you open it, so collapsing costs no
 * information - "14 save points" answers the question "is there anything in
 * here?" without expanding.
 */
export function Fold({ title, summary, open, onToggle, children }) {
  return h('div', { className: `cgp-fold ${open ? 'cgp-fold--open' : ''}` },
    h('button', {
      className: 'cgp-fold__head',
      onClick: onToggle,
      'aria-expanded': open ? 'true' : 'false'
    },
      h('span', { className: 'cgp-fold__caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      h('span', { className: 'cgp-fold__title' }, title),
      summary && h('span', { className: 'cgp-fold__summary' }, summary)
    ),

    open && h('div', { className: 'cgp-fold__body' }, children)
  );
}

/**
 * The one thing worth doing, at full weight.
 *
 * What it must not become is a seventh block. It replaces the reader's job
 * of scanning six equal blocks to work out which applies - so it states the
 * situation, says what the button will do, and hands off to the same routine
 * component that would have done it anyway. It decides *nothing*: the
 * routine it opens still previews and still confirms.
 *
 * The `also` rows are deliberately plain text buttons rather than a second
 * row of primaries. They exist so that disagreeing with the lead costs one
 * click, not so that they compete with it.
 */
export function NextAction({ next, busy, onChoose, chosen }) {
  if (!next || !next.action) {
    return null;
  }

  const { action, also } = next;

  const TONE_ICON = { urgent: 'Warning', action: 'ArrowUp', calm: 'CheckmarkFilled' };

  return h('div', { className: `cgp-lead cgp-lead--${action.tone}` },
    h('p', {
      className: 'cgp-lead__title',
      style: { display: 'flex', alignItems: 'center', gap: '8px' }
    },
      h(Icon, {
        name: TONE_ICON[action.tone] || 'ArrowUp',
        size: 15,
        className: `cgp-lead__icon cgp-tone--${action.tone}`
      }),
      h('span', null, action.title)
    ),
    action.detail && h('p', { className: 'cgp-lead__detail' }, action.detail),

    action.cta && h('div', { className: 'cgp-field' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: busy,
        onClick: () => onChoose(action.id)
      }, action.cta)
    ),

    (also || []).length > 0 && h('p', { className: 'cgp-lead__also' },
      h('span', { className: 'cgp-sub' }, 'or '),
      also.map((row, i) => h('span', { key: row.id },
        i > 0 && h('span', { className: 'cgp-sub' }, ' · '),
        h('button', {
          className: 'btn cgp-btn cgp-btn--link',
          disabled: busy,
          'aria-pressed': chosen === row.id ? 'true' : 'false',
          onClick: () => onChoose(row.id)
        }, row.label)
      ))
    )
  );
}

/**
 * The save points on this workstream, and going back to one.
 *
 * Presented as a list of *moments* rather than a history: what changed, who
 * changed it, when. The graph view in Source Control is the developer's
 * answer to the same question; this is the one an analyst can act on.
 *
 * Going back is preview-then-confirm like every other routine, and the
 * preview is doing real work here rather than being ceremony - it is where
 * the reader finds out which diagrams the change touches and, crucially,
 * that nothing is being deleted. That reassurance has to arrive *before*
 * the button, because "roll back" sounds destructive and in most tools is.
 */
export function SavePoints({ savePoints, actions, busy, disabled }) {
  const [ chosen, setChosen ] = useState(null);
  const [ plan, setPlan ] = useState(null);
  const [ result, setResult ] = useState(null);
  const [ working, setWorking ] = useState(false);
  const [ expanded, setExpanded ] = useState(false);

  const locked = busy || working || disabled;
  const points = (savePoints && savePoints.savePoints) || [];

  if (!points.length) {
    return null;
  }

  const shown = expanded ? points : points.slice(0, 8);

  const preview = async point => {
    setResult(null);
    setChosen(point);
    setWorking(true);

    try {
      setPlan(await actions.previewRollback(point.hash));
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    setWorking(true);

    try {
      const res = await actions.runRollback(chosen.hash);
      setResult(res);
      setPlan(null);
      setChosen(null);
    } finally {
      setWorking(false);
    }
  };

  const cancel = () => {
    setPlan(null);
    setChosen(null);
  };

  // No heading of its own: this now lives in a labelled column, and two
  // headings stacked on one list reads as two sections.
  return h('div', null,
    h('p', { className: 'cgp-sub' },
      'Every save point on this workstream. You can put your diagrams back to ' +
      'any of them.'
    ),

    h('ul', { className: 'cgp-savepoints' },
      shown.map(point => h('li', {
        key: point.hash,
        className: `cgp-savepoint ${point.isHead ? 'cgp-savepoint--head' : ''}`
      },
        h('div', { className: 'cgp-savepoint__main' },
          h('span', { className: 'cgp-savepoint__subject', title: point.subject },
            point.subject || '(no description)'
          ),
          h('span', { className: 'cgp-savepoint__meta' }, [
            point.isHead ? 'where you are now' : null,
            point.author,
            point.date ? timeAgo(point.date) : null,
            point.changedFiles
              ? `${point.changedFiles} ${point.changedFiles === 1 ? 'file' : 'files'}`
              : null
          ].filter(Boolean).join(' · '))
        ),

        !point.isHead && h('button', {
          className: 'btn cgp-btn cgp-savepoint__action',
          disabled: locked,
          title: `Put every diagram back to how it was at "${point.subject}"`,
          onClick: () => preview(point)
        }, 'Go back to this')
      ))
    ),

    points.length > shown.length && h('button', {
      className: 'btn cgp-btn cgp-btn--link',
      onClick: () => setExpanded(true)
    }, `Show all ${points.length}`),

    plan && h('div', { className: 'cgp-block cgp-block--nested' },
      plan.possible === false
        ? h('p', { className: 'cgp-empty' }, plan.reason || plan.error)
        : h('div', null,
          h('p', { className: 'cgp-sub' },
            `Going back to "${plan.subject}" will:`
          ),
          h('ol', { className: 'cgp-plan' },
            (plan.steps || []).map(s => h('li', { key: s.key }, s.label))
          ),

          plan.fileCount > 0 && h('details', { style: { margin: '6px 0' } },
            h('summary', { style: { cursor: 'pointer', fontSize: '11px' } },
              `Which ${plan.fileCount === 1 ? 'file' : 'files'} (${plan.fileCount})`
            ),
            h('ul', { className: 'cgp-filelist' },
              (plan.files || []).map(f => h('li', { key: f.path },
                h('span', { className: `cgp-effect cgp-effect--${f.effect}` }, f.effect),
                f.path
              )),
              plan.truncated && h('li', { className: 'cgp-sub' }, '...and more')
            )
          ),

          (plan.warnings || []).map((w, i) =>
            h('div', { key: i, className: 'cgp-notice cgp-notice--warn' }, w)
          ),

          h('div', { className: 'cgp-field' },
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary', disabled: locked, onClick: confirm
            }, working ? 'Working...' : 'Yes, go back to this'),
            h('button', {
              className: 'btn cgp-btn', disabled: locked, onClick: cancel
            }, 'Cancel')
          )
        )
    ),

    result && h('div', { style: { marginTop: '10px' } },
      h('ul', { className: 'cgp-steps' },
        (result.steps || []).map(s => h('li', { key: s.key },
          h('span', { className: s.ok ? 'cgp-step-ok' : 'cgp-step-fail' }, s.ok ? '✓' : '✕'),
          s.label
        ))
      ),
      h('div', { className: 'cgp-notice cgp-notice--success' }, result.summary)
    )
  );
}

export function Setup({ setup, actions, busy }) {
  const [ open, setOpen ] = useState(null);
  const [ name, setName ] = useState('');
  const [ email, setEmail ] = useState('');
  const [ url, setUrl ] = useState('');
  const [ message, setMessage ] = useState('');
  const [ cloneUrl, setCloneUrl ] = useState('');
  const [ cloning, setCloning ] = useState(false);

  if (!setup) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Checking how this project is set up...'));
  }

  const next = setup.next;
  const active = open || (next && next.id);
  const identity = (setup.steps.find(s => s.id === 'identity') || {}).value || {};

  const run = (fn) => () => { setOpen(null); fn(); };

  const forms = {
    'folder': () => h('div', { className: 'cgp-setup__form' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary', disabled: busy,
        onClick: run(actions.pickFolder)
      }, 'Choose a folder'),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: () => setCloning(!cloning)
      }, 'Get the team\'s project instead'),

      cloning && h('div', { style: { marginTop: '8px' } },
        h('p', { className: 'cgp-sub' },
          'Paste the address someone sent you. A copy is made on this ' +
          'computer; nothing on the server is changed.'),
        h('div', { className: 'cgp-field' },
          h('input', {
            type: 'text', className: 'cgp-input', value: cloneUrl,
            placeholder: 'https://github.com/team/processes.git',
            disabled: busy,
            onChange: e => setCloneUrl(e.target.value)
          }),
          h('button', {
            className: 'btn cgp-btn', disabled: busy || !cloneUrl.trim(),
            onClick: run(() => actions.cloneProject(cloneUrl.trim()))
          }, 'Get a copy')
        )
      )
    ),

    'repository': () => h('div', { className: 'cgp-setup__form' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary', disabled: busy,
        onClick: run(actions.initRepository)
      }, 'Start tracking changes')
    ),

    'identity': () => h('div', { className: 'cgp-setup__form' },
      h('div', { className: 'cgp-field', style: { marginBottom: '6px' } },
        h('input', {
          type: 'text', className: 'cgp-input',
          placeholder: 'Your name', disabled: busy,
          value: name || identity.name || '',
          onChange: e => setName(e.target.value)
        })
      ),
      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text', className: 'cgp-input',
          placeholder: 'you@company.com', disabled: busy,
          value: email || identity.email || '',
          onChange: e => setEmail(e.target.value)
        }),
        h('button', {
          className: 'btn cgp-btn cgp-btn--primary', disabled: busy,
          onClick: run(() => actions.setIdentity({
            name: name || identity.name, email: email || identity.email
          }))
        }, 'Save')
      ),
      h('p', { className: 'cgp-sub' }, 'Used for this project only.')
    ),

    'first-save': () => h('div', { className: 'cgp-setup__form' },
      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text', className: 'cgp-input', value: message,
          placeholder: 'Starting point', disabled: busy,
          onChange: e => setMessage(e.target.value)
        }),
        h('button', {
          className: 'btn cgp-btn cgp-btn--primary', disabled: busy,
          onClick: run(() => actions.createFirstSavePoint(message.trim() || 'Starting point'))
        }, 'Create it')
      )
    ),

    'server': () => h('div', { className: 'cgp-setup__form' },
      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text', className: 'cgp-input', value: url,
          placeholder: 'https://github.com/team/processes.git', disabled: busy,
          onChange: e => setUrl(e.target.value)
        }),
        h('button', {
          className: 'btn cgp-btn cgp-btn--primary',
          disabled: busy || !url.trim(),
          onClick: run(() => actions.connectRemote(url.trim()))
        }, 'Connect')
      ),
      h('p', { className: 'cgp-sub' },
        'Checked before it is saved. Nothing is sent until you ask.')
    ),

    'project': () => h('div', { className: 'cgp-setup__form' },
      h('p', { className: 'cgp-sub' },
        'Open Git Settings to write down which branches the team uses.')
    )
  };

  return h('div', { className: 'cgp-panel' },
    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' },
        setup.complete ? 'This project is set up' : 'Let\'s get this project started'),
      h('p', { className: 'cgp-sub' },
        setup.complete
          ? 'Everything needed is in place. The optional steps below are ' +
            'still worth doing.'
          : 'A few one-off things, then the rest of the plugin works normally.'
      )
    ),

    h('ol', { className: 'cgp-setup' },
      setup.steps.map(s => h('li', {
        key: s.id,
        className: `cgp-setup__step ${s.done ? 'cgp-setup__step--done' : ''} ` +
          `${s.blocked ? 'cgp-setup__step--blocked' : ''}`
      },
        h('div', { className: 'cgp-setup__head' },
          h('span', { className: 'cgp-setup__mark' }, s.done ? '✓' : s.blocked ? '·' : '○'),
          h('button', {
            className: 'cgp-setup__title',
            disabled: s.blocked || busy,
            onClick: () => setOpen(open === s.id ? null : s.id)
          }, s.title),
          s.optional && h('span', { className: 'cgp-row__meta' }, 'optional')
        ),

        h('p', { className: 'cgp-setup__detail', title: s.detail }, s.detail),

        active === s.id && !s.blocked && forms[s.id] && forms[s.id]()
      ))
    )
  );
}

/**
 * Detached HEAD, shown wherever the user is rather than waiting for them to
 * press something that fails.
 *
 * This state is silently dangerous - save points made here belong to no
 * workstream - so it is announced up front, with the recovery attached.
 */
export function DetachedNotice({ status, actions, busy }) {
  if (!status || !status.detached) {
    return null;
  }

  return h('div', { className: 'cgp-notice cgp-notice--warn' },
    h('div', { className: 'cgp-notice__title' }, 'You are looking at an old version'),
    h('div', { className: 'cgp-notice__body' },
      'You are not on a workstream right now. You can look around safely, ' +
      'but anything saved here would be hard to find again.'
    ),
    h('div', { className: 'cgp-field', style: { marginTop: '8px' } },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: busy,
        onClick: () => actions.applyFix('return-to-workstream')
      }, 'Put me back on a workstream')
    ),
    h('p', { className: 'cgp-sub' },
      'Saves anything unsaved first, and gives it its own workstream if it ' +
      'is not already on one. Nothing is discarded.'
    )
  );
}

// ---------------------------------------------------------------- context

function ContextRow({ label, children, title }) {
  if (!children) {
    return null;
  }

  return h('div', { className: 'cgp-ctx__row', title },
    h('span', { className: 'cgp-ctx__label' }, label),
    h('span', { className: 'cgp-ctx__value' }, children)
  );
}

/**
 * Where am I, and what am I connected to.
 *
 * Collapsed to a single line by default - the answers only matter when
 * something is wrong, and that is exactly when nobody can find them. The
 * expanded form is deliberately dense and unstyled-looking: it is the thing
 * a user screenshots and sends to whoever supports them.
 */
export function RepoContext({ context, busy, onRefresh, defaultOpen }) {
  const [ open, setOpen ] = useState(!!defaultOpen);

  if (!context) {
    return null;
  }

  const { repo, branch, head, identity, remote, project, work } = context;

  const summary = [
    repo.name,
    branch.current || 'no branch',
    work.clean ? 'no changes' : `${work.changed} changed`
  ].join(' · ');

  return h('div', { className: 'cgp-ctx' },
    h('div', { className: 'cgp-ctx__head' },
      h('button', {
        className: 'cgp-ctx__toggle',
        onClick: () => setOpen(!open),
        title: open ? 'Hide the details' : 'Show where this project lives'
      }, `${open ? '▾' : '▸'} ${summary}`),

      h('span', { className: 'cgp-toolbar__spacer' }),

      open && h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: onRefresh
      }, 'Refresh')
    ),

    open && h('div', { className: 'cgp-ctx__body' },

      h(ContextRow, { label: 'Folder', title: repo.path }, repo.path),

      h(ContextRow, { label: 'Working on' },
        branch.current
          ? h('span', null,
            branch.title,
            branch.ticketUrl && h('a', {
              className: 'cgp-ticket cgp-ticket--link',
              style: { marginLeft: '6px' },
              href: branch.ticketUrl, target: '_blank', rel: 'noreferrer'
            }, branch.ticket)
          )
          : (branch.detached ? 'Not on a workstream (detached)' : null)
      ),

      h(ContextRow, { label: 'Team copy' },
        branch.upstream
          ? `${branch.upstream}${branch.ahead ? ` · ${branch.ahead} to send` : ''}` +
            `${branch.behind ? ` · ${branch.behind} to get` : ''}`
          : 'not on the server yet'
      ),

      h(ContextRow, { label: 'Server' },
        remote
          ? h('span', null,
            remote.webUrl
              ? h('a', {
                href: remote.webUrl, target: '_blank', rel: 'noreferrer',
                className: 'cgp-ctx__link'
              }, remote.path || remote.url)
              : (remote.path || remote.url),
            remote.provider && h('span', { className: 'cgp-row__meta' }, `  ${remote.provider}`)
          )
          : 'none - this project is on this computer only'
      ),

      h(ContextRow, { label: 'Last save point' },
        head
          ? h('span', null,
            h('span', { className: 'cgp-ctx__sha' }, head.short),
            ` ${head.subject}`,
            h('span', { className: 'cgp-row__meta' },
              `  ${head.author}, ${timeAgo(head.date)}`)
          )
          : 'nothing saved yet'
      ),

      h(ContextRow, {
        label: 'Saving as',
        title: 'Commits you make are attributed to this'
      },
        identity.configured
          ? `${identity.name} <${identity.email}>`
          : h('span', { className: 'cgp-sub--warn' },
            'not set up - ask whoever set this computer up')
      ),

      h(ContextRow, { label: 'Set up as' },
        h('span', null,
          project.model === 'gitflow'
            ? `separate live version · everyday "${project.base}" · live "${project.release}"`
            : `one shared version · "${project.base}"`,
          h('span', { className: 'cgp-row__meta' },
            `  ${project.mergePolicy === 'direct' ? 'merge directly' : 'review first'}`),
          !project.configured && h('span', { className: 'cgp-sub--warn' }, '  (guessed)')
        )
      ),

      project.warning && h('p', { className: 'cgp-sub cgp-sub--warn' }, project.warning)
    )
  );
}

// -------------------------------------------------------------- releases

/**
 * The integrator's tab.
 *
 * The third role in this plugin. An analyst wants "save my work"; a
 * developer wants a console and a graph; the integrator has to answer what
 * is live, what is queued behind it, and whether anything is half
 * integrated - and had nowhere to answer it from.
 *
 * Only rendered for projects using Gitflow. On a single-branch project
 * there is no separate released branch, so every control here would be
 * inert, and a permanently inapplicable tab is worse than no tab.
 */
export function Releases({ release, changes, actions, busy }) {
  const [ version, setVersion ] = useState('');
  const [ working, setWorking ] = useState(false);
  const [ result, setResult ] = useState(null);
  const [ plan, setPlan ] = useState(null);
  const [ send, setSend ] = useState(true);
  const [ hotfixTitle, setHotfixTitle ] = useState('');
  const [ hotfixTicket, setHotfixTicket ] = useState('');

  if (!release || !release.applicable) {
    return null;
  }

  const locked = busy || working;

  const onRelease = String(release.current || '').startsWith('release/');
  const onHotfix = String(release.current || '').startsWith('hotfix/');
  const integrating = onRelease || onHotfix;

  const suggested = integrating
    ? (onHotfix ? release.suggestedHotfix : release.suggestedRelease)
    : release.suggestedRelease;

  const run = async fn => {
    setWorking(true);
    try {
      setResult(await fn());
    } finally {
      setWorking(false);
    }
  };

  const steps = (result && result.steps) || [];
  const latest = (release.tags && release.tags[0]) || null;
  const inFlightCount = (release.inFlight || []).length;

  return h('div', { className: 'cgp-panel' },

    // What is live, and what is waiting behind it - the state, shown rather
    // than described. Version, a live badge, and the three numbers an
    // integrator actually watches.
    h('div', { className: 'cgp-hero' },
      h('div', { className: 'cgp-hero__main' },
        h('span', { className: 'cgp-hero__eyebrow' }, 'Currently live'),

        release.lastTag
          ? h('div', { className: 'cgp-hero__line' },
            h('span', { className: 'cgp-hero__version' }, release.lastTag),
            h('span', { className: 'cgp-pill cgp-pill--live' }, 'Live')
          )
          : h('div', { className: 'cgp-hero__line' },
            h('span', { className: 'cgp-hero__none' }, 'Nothing released yet')
          ),

        h('p', { className: 'cgp-hero__detail' },
          release.lastTag
            ? (latest && latest.date
              ? `Released ${timeAgo(latest.date)} · everyday work carries on on "${release.base}"`
              : `On "${release.release}" · everyday work carries on on "${release.base}"`)
            : `Cut the first release from "${release.base}" when you are ready.`
        )
      ),

      h('div', { className: 'cgp-stats' },
        h('div', { className: 'cgp-stat' },
          h('span', {
            className: 'cgp-stat__num cgp-stat__num--' + (release.unreleased ? 'queued' : 'zero')
          }, String(release.unreleased || 0)),
          h('span', { className: 'cgp-stat__label' }, 'Queued')
        ),
        h('div', { className: 'cgp-stat' },
          h('span', {
            className: 'cgp-stat__num cgp-stat__num--' + (inFlightCount ? 'flight' : 'zero')
          }, String(inFlightCount)),
          h('span', { className: 'cgp-stat__label' }, 'In flight')
        ),
        h('div', { className: 'cgp-stat' },
          h('span', {
            className: 'cgp-stat__num cgp-stat__num--' + (release.missingBackMerge ? 'flight' : 'zero')
          }, String(release.missingBackMerge || 0)),
          h('span', { className: 'cgp-stat__label' }, 'Unmerged')
        )
      )
    ),

    // How a release travels, drawn once. The "back" arrow is the whole
    // reason the missing-back-merge warning exists, so it is worth a picture.
    h('div', { className: 'cgp-flow' },
      h('span', { className: 'cgp-flow__node cgp-flow__node--base' }, h('code', null, release.base)),
      h('span', { className: 'cgp-flow__arrow' }, '→'),
      h('span', { className: 'cgp-flow__node cgp-flow__node--ship' }, 'release / hotfix'),
      h('span', { className: 'cgp-flow__arrow' }, '→'),
      h('span', { className: 'cgp-flow__node cgp-flow__node--release' },
        h(Icon, { name: 'Tag', size: 12 }),
        h('code', null, release.release)
      ),
      h('span', { className: 'cgp-flow__back' },
        'then ', h('b', null, `back into ${release.base}`),
        ' — both, so the next release keeps the change.'
      )
    ),

    // Findings first: a missing back-merge silently loses work at the next
    // release, so it outranks anything anyone came here to do.
    (release.findings || []).map(f => h('div', {
      key: f.id,
      className: `cgp-notice cgp-notice--${f.severity === 'warning' ? 'warn' : 'success'}`
    },
      h('div', { className: 'cgp-notice__title' }, f.title),
      h('div', { className: 'cgp-notice__body' }, f.detail),

      f.fix === 'back-merge' && h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: locked,
        style: { marginTop: '8px' },
        onClick: () => run(() => actions.backMerge())
      }, `Bring them into "${release.base}"`)
    )),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' },
        integrating
          ? `Put "${release.current}" live`
          : 'Start the next release'
      ),

      h('p', { className: 'cgp-sub' },
        integrating
          ? `This goes onto "${release.release}", gets marked with a version, ` +
            `and comes back into "${release.base}" - both, so the next ` +
            'release does not undo it.'
          : release.unreleased
            ? `Takes everything queued on "${release.base}" onto its own ` +
              'branch, so everyday work can carry on while it is checked.'
            : 'There is nothing queued to release yet.'
      ),

      (integrating || release.unreleased > 0) && h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text',
          className: 'cgp-input',
          value: version,
          placeholder: suggested,
          disabled: locked,
          onChange: e => setVersion(e.target.value)
        }),
        h('button', {
          className: 'btn cgp-btn cgp-btn--primary',
          disabled: locked,
          onClick: () => integrating
            ? run(async () => {
              setPlan(await actions.previewIntegrate({
                branch: release.current,
                version: version.trim() || suggested
              }));
              return null;
            })
            : run(() => actions.startRelease(version.trim() || suggested))
        }, working
          ? 'Checking...'
          : (integrating ? 'Check what this will do' : 'Cut the release'))
      )
    ),

    // The other way forward from here: not the planned release, but an
    // urgent fix to what is already live. Kept off the tab while a release
    // or hotfix is checked out - that is the moment to finish the one in
    // hand, not start another.
    !integrating && h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'Something is broken in what is live'),

      h('p', { className: 'cgp-sub' },
        `An urgent fix starts from "${release.release}" - what is actually ` +
        'live, not everyday work - so it can go out without waiting for the ' +
        'next release. When it is done it goes live and comes back into both ' +
        'branches.'
      ),

      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text',
          className: 'cgp-input',
          value: hotfixTitle,
          placeholder: 'What is broken? e.g. Approvals not sending',
          disabled: locked,
          onChange: e => setHotfixTitle(e.target.value)
        })
      ),

      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text',
          className: 'cgp-input',
          value: hotfixTicket,
          placeholder: release.projectKey
            ? `Ticket, e.g. ${release.projectKey}-1234 (optional)`
            : 'Ticket (optional)',
          disabled: locked,
          onChange: e => setHotfixTicket(e.target.value)
        }),
        h('button', {
          className: 'btn cgp-btn',
          disabled: locked || !hotfixTitle.trim(),
          onClick: () => run(async () => {
            const res = await actions.startHotfix({
              title: hotfixTitle.trim(),
              ticket: hotfixTicket.trim() || undefined
            });

            setHotfixTitle('');
            setHotfixTicket('');

            return res;
          })
        }, working ? 'Starting...' : 'Start an urgent fix')
      )
    ),

    // The preview. This is the whole point of the tab: releasing writes to
    // two branches and creates a tag, and a pushed tag is the one thing
    // here that is genuinely awkward to take back. Nothing happens until
    // this has been read.
    plan && h('div', { className: 'cgp-block cgp-block--nested' },
      plan.blockers && plan.blockers.length
        ? h('div', null,
          h('p', { className: 'cgp-block__title' }, 'This cannot be released yet'),
          plan.blockers.map(b => h('div', {
            key: b.id, className: 'cgp-notice cgp-notice--error'
          },
            h('div', { className: 'cgp-notice__title' }, b.title),
            h('div', { className: 'cgp-notice__body' }, b.detail)
          )),
          h('button', {
            className: 'btn cgp-btn', disabled: locked, onClick: () => setPlan(null)
          }, 'Close')
        )
        : h('div', null,
          h('p', { className: 'cgp-block__title' },
            `Release ${plan.version}` +
            (plan.commits ? ` · ${plan.commits} change${plan.commits === 1 ? '' : 's'}` : '')
          ),

          h('p', { className: 'cgp-sub' }, 'This will:'),
          h('ol', { className: 'cgp-plan' },
            (plan.steps || []).map(s => h('li', { key: s.key }, s.label))
          ),

          (plan.warnings || []).map((w, i) =>
            h('div', { key: i, className: 'cgp-notice cgp-notice--warn' }, w)
          ),

          plan.hasRemote && h('label', { className: 'cgp-check' },
            h('input', {
              type: 'checkbox',
              checked: send,
              disabled: locked,
              onChange: e => setSend(e.target.checked)
            }),
            ' Send it to the team when done (a release nobody can see is not ' +
            'really released)'
          ),

          h('div', { className: 'cgp-field' },
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary',
              disabled: locked,
              onClick: () => run(async () => {
                const res = await actions.integrateRelease({
                  branch: plan.branch,
                  version: plan.version,
                  send
                });
                setPlan(null);
                return res;
              })
            }, working ? 'Working...' : `Release ${plan.version}`),
            h('button', {
              className: 'btn cgp-btn', disabled: locked, onClick: () => setPlan(null)
            }, 'Cancel')
          )
        )
    ),

    // Anything half-done: an open release branch, a hotfix in flight.
    (release.inFlight || []).length > 0 && h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'In flight'),
      h('ul', { className: 'cgp-list' },
        release.inFlight.map(name => h('li', { key: name, className: 'cgp-row' },
          h('span', { className: 'cgp-row__name' }, name),
          h('span', { className: 'cgp-row__actions' },
            name === release.current
              ? h('span', { className: 'cgp-row__meta' }, 'you are here')
              : h('button', {
                className: 'btn cgp-btn',
                disabled: locked,
                onClick: () => actions.switchWorkstream(name)
              }, 'Switch to it')
          )
        ))
      )
    ),

    result && h('div', { className: 'cgp-block' },
      h('ul', { className: 'cgp-steps' },
        steps.map(s => h('li', { key: s.key },
          h('span', { className: s.ok ? 'cgp-step-ok' : 'cgp-step-fail' }, s.ok ? '✓' : '✕'),
          s.label
        ))
      ),
      h('div', {
        className: 'cgp-notice cgp-notice--' +
          (result.needsDecision ? 'warn' : 'success')
      }, result.summary)
    ),

    // The changelog. The artefact integrators otherwise rebuild by hand
    // from `git log` every time somebody asks what is in this release.
    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' },
        `Going into the next release (${(changes && changes.changes || []).length})`
      ),
      (changes && changes.changes || []).length
        ? h('ul', { className: 'cgp-savepoints' },
          changes.changes.map(c => h('li', { key: c.short, className: 'cgp-savepoint' },
            h('div', { className: 'cgp-savepoint__main' },
              h('span', { className: 'cgp-savepoint__subject' }, c.subject),
              h('span', { className: 'cgp-savepoint__meta' },
                [ c.ticket, c.author, c.date ? timeAgo(c.date) : null ]
                  .filter(Boolean).join(' · '))
            )
          ))
        )
        : h('p', { className: 'cgp-empty' }, 'Nothing queued.')
    ),

    // Recent releases, as a scannable row of version chips - the history the
    // integrator glances at to answer "what did the last few go out as?".
    (release.tags || []).length > 0 && h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-section-label' }, 'Recent releases'),
      h('div', { className: 'cgp-tags' },
        release.tags.slice(0, 8).map((t, i) => h('span', {
          key: t.name,
          className: 'cgp-tagchip' + (i === 0 ? ' cgp-tagchip--latest' : ''),
          title: t.subject || ''
        },
          h(Icon, { name: 'Tag', size: 11 }),
          t.name,
          t.date && h('span', { className: 'cgp-tagchip__date' }, timeAgo(t.date))
        ))
      )
    )
  );
}

// -------------------------------------------------------------- search

const TYPE_LABEL = t => String(t || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/^./, c => c.toUpperCase());

/**
 * Search across every diagram - by name, type, and the camunda:* config a
 * raw grep never sees. Its own small state: the query, the debounce, and the
 * last result, because a search box that lifts every keystroke into the app
 * is a search box that stutters.
 */
export function SearchDiagrams({ search, onOpen }) {
  const [ query, setQuery ] = useState('');
  const [ result, setResult ] = useState(null);
  const [ busy, setBusy ] = useState(false);

  const timer = useRef(null);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();

    if (timer.current) clearTimeout(timer.current);

    if (q.length < 2) {
      setResult(null);
      setBusy(false);
      return undefined;
    }

    setBusy(true);
    const mine = ++reqId.current;

    timer.current = setTimeout(async () => {
      try {
        const res = await search(q);
        // Ignore a slow response overtaken by a newer keystroke.
        if (mine === reqId.current) setResult(res);
      } catch (err) {
        if (mine === reqId.current) setResult({ error: err.message, groups: [] });
      } finally {
        if (mine === reqId.current) setBusy(false);
      }
    }, 250);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [ query, search ]);

  const groups = (result && result.groups) || [];

  return h('div', { className: 'cgp-panel' },
    h('div', { className: 'cgp-search__box' },
      h('input', {
        className: 'cgp-input cgp-search__input',
        placeholder: 'Search every diagram - a name, or assignee:jdoe, calls:Invoice, type:userTask, timer',
        value: query,
        autoFocus: true,
        onChange: e => setQuery(e.target.value)
      }),
      query && h('button', {
        className: 'cgp-search__clear', title: 'Clear',
        onClick: () => setQuery('')
      }, '×')
    ),

    h('div', { className: 'cgp-search__hint' },
      busy ? 'Searching…'
        : result && !result.error
          ? `${result.totalHits} match${result.totalHits === 1 ? '' : 'es'} in ` +
            `${groups.length} diagram${groups.length === 1 ? '' : 's'}` +
            ` · searched ${result.filesSearched}` +
            (result.truncated ? ' · showing the first results, narrow the search' : '')
          : query.trim().length < 2
            ? 'Type at least two characters. Filters: assignee: group: calls: delegate: form: timer type:'
            : ''
    ),

    result && result.error
      ? h('p', { className: 'cgp-empty' }, result.error)
      : query.trim().length >= 2 && !busy && !groups.length
        ? h('p', { className: 'cgp-empty' }, `Nothing matches “${query.trim()}”.`)
        : null,

    h('ul', { className: 'cgp-search__results' },
      groups.map(group => h('li', { key: group.path, className: 'cgp-search__group' },
        h('div', {
          className: 'cgp-search__file',
          title: `Open ${group.path}`,
          onClick: () => onOpen(group.path)
        },
          h('span', { className: 'cgp-search__filename' }, prettyName(group.name)),
          h('span', { className: 'cgp-search__count' },
            group.matchedName
              ? 'name matches'
              : `${group.hitCount} match${group.hitCount === 1 ? '' : 'es'}`)
        ),

        group.hits.length ? h('ul', { className: 'cgp-search__hits' },
          group.hits.map((hit, i) => h('li', {
            key: `${hit.id}-${i}`,
            className: 'cgp-search__hit',
            title: `Open ${group.name}`,
            onClick: () => onOpen(group.path)
          },
            h('span', { className: 'cgp-search__el' },
              h('span', { className: 'cgp-search__elname' }, hit.name || hit.id),
              h('span', { className: 'cgp-search__eltype' }, TYPE_LABEL(hit.type))
            ),
            hit.matches.length ? h('div', { className: 'cgp-search__props' },
              hit.matches.map((m, j) => h('span', { key: j, className: 'cgp-search__prop' },
                h('span', { className: 'cgp-search__proplabel' }, `${m.label}: `),
                h('span', { className: 'cgp-search__propval' }, m.value)
              ))
            ) : null
          ))
        ) : null
      ))
    )
  );
}

// -------------------------------------------------------------- ai edit

function aiChangeRow(entry, kind) {
  const tag = kind === 'changed' ? 'edited' : kind === 'added' ? 'added' : 'deleted';

  return h('li', { key: `${kind}-${entry.id}`, className: 'cgp-search__hit' },
    h('div', { className: 'cgp-search__el' },
      h('span', { className: `cgp-tag cgp-tag--${tag}` }, kind.toUpperCase()),
      h('span', { className: 'cgp-search__elname' }, entry.name || entry.id),
      entry.type && h('span', { className: 'cgp-search__eltype' }, entry.type)
    ),
    entry.changes && entry.changes.length
      ? h('div', { className: 'cgp-search__props' },
        entry.changes.map((ch, i) => h('span', { key: i, className: 'cgp-search__prop' },
          h('span', { className: 'cgp-search__proplabel' }, `${ch.label}: `),
          ch.from !== null && ch.from !== undefined && ch.from !== ''
            ? h('span', { className: 'cgp-ai__from' }, `${ch.from} → `) : null,
          h('span', { className: 'cgp-search__propval' },
            ch.to === null || ch.to === undefined ? '(removed)' : ch.to)
        )))
      : null
  );
}

/**
 * AI edits, preview-then-apply. Describe a change; the model rewrites the
 * diagram; the result is validated as real BPMN, diffed, and only written
 * when the user accepts - the same contract the routines follow, applied to
 * something a lot less predictable.
 */
export function AiEdit({ diagrams, settings, actions, busy }) {
  const hasKey = !!(settings && settings.hasOpenRouterKey);
  const modelName = (settings && settings.openRouterModel) || 'the configured model';
  const list = diagrams || [];

  const [ path, setPath ] = useState('');
  const [ instruction, setInstruction ] = useState('');
  const [ preview, setPreview ] = useState(null);
  const [ models, setModels ] = useState(null);

  // Load the real model catalogue once a key is present, so the picker
  // offers ids that actually resolve rather than a guessed default.
  useEffect(() => {
    if (!hasKey) return undefined;

    let alive = true;
    actions.aiModels()
      .then(res => { if (alive && res && res.models) setModels(res.models); })
      .catch(() => { if (alive) setModels([]); });

    return () => { alive = false; };
  }, [ hasKey, actions ]);

  const target = path || (list[0] && list[0].path) || '';
  const currentModel = (settings && settings.openRouterModel) || '';

  if (!hasKey) {
    return h('div', { className: 'cgp-panel' },
      h('div', { className: 'cgp-notice cgp-notice--warn' },
        h('div', { className: 'cgp-notice__title' }, 'AI edits need an OpenRouter key'),
        h('div', { className: 'cgp-notice__body' },
          'Add your OpenRouter API key under Git Settings. Then describe a change ' +
          'here and it is applied to a diagram - with a before/after preview, and ' +
          'nothing saved until you accept.')));
  }

  const runPreview = async () => {
    setPreview(null);
    const res = await actions.aiPreview(target, instruction);
    if (res && res.ok) setPreview(res);
  };

  const apply = async () => {
    const res = await actions.aiApply(target);
    if (res) { setPreview(null); setInstruction(''); }
  };

  const discard = () => { actions.aiDiscard(target); setPreview(null); };

  const canRun = !busy && !!target && instruction.trim().length > 0;
  const diff = (preview && preview.diff) || {};
  const s = diff.summary || {};

  return h('div', { className: 'cgp-panel' },
    !list.length
      ? h('p', { className: 'cgp-empty' }, 'No BPMN diagrams in this project yet.')
      : h('div', null,
        h('div', { className: 'cgp-field', style: { marginBottom: '8px' } },
          h('span', { className: 'cgp-row__meta', style: { minWidth: '64px' } }, 'Diagram'),
          h('select', {
            className: 'cgp-input', value: target, disabled: busy,
            onChange: e => { setPath(e.target.value); setPreview(null); }
          }, list.map(d => h('option', { key: d.path, value: d.path }, d.title)))
        ),

        h('div', { className: 'cgp-field', style: { marginBottom: '8px' } },
          h('span', { className: 'cgp-row__meta', style: { minWidth: '64px' } }, 'Model'),
          models && models.length
            ? h('select', {
              className: 'cgp-input', value: currentModel, disabled: busy,
              onChange: e => actions.setModel(e.target.value)
            },
              // Keep the current value selectable even if the catalogue does
              // not list it, so the box never shows blank.
              (models.some(m => m.id === currentModel)
                ? models
                : [ { id: currentModel, name: `${currentModel} (current)` } ].concat(models)
              ).map(m => h('option', { key: m.id, value: m.id }, m.id))
            )
            : h('input', {
              className: 'cgp-input', type: 'text', defaultValue: currentModel, disabled: busy,
              placeholder: 'anthropic/claude-sonnet-4.5',
              title: models === null ? 'Loading the model list…' : 'Could not load the model list - type an id, saved when you click away',
              onBlur: e => { if (e.target.value !== currentModel) actions.setModel(e.target.value); }
            })
        ),

        h('textarea', {
          className: 'cgp-input cgp-ai__prompt', rows: 3,
          placeholder: 'Describe the change - e.g. "add a 2-day timer boundary event on Approve invoice", or "make Charge card asynchronous before"',
          value: instruction, disabled: busy,
          onChange: e => setInstruction(e.target.value)
        }),

        h('div', { className: 'cgp-field', style: { marginTop: '8px' } },
          h('button', {
            className: 'btn cgp-btn cgp-btn--primary', disabled: !canRun, onClick: runPreview
          }, 'Preview edit'),
          h('span', { className: 'cgp-sub' }, `Sends this diagram to ${modelName}`)
        ),

        preview && !preview.hasChanges && h('div', {
          className: 'cgp-notice cgp-notice--warn', style: { marginTop: '10px' }
        },
          h('div', { className: 'cgp-notice__title' }, 'No change'),
          h('div', { className: 'cgp-notice__body' },
            'The AI did not change anything. Try a more specific instruction.')),

        preview && preview.hasChanges && h('div', { className: 'cgp-ai__result' },
          h('div', { className: 'cgp-ai__summary' },
            `${s.added || 0} added · ${s.changed || 0} changed · ${s.removed || 0} removed`),

          h('ul', { className: 'cgp-search__results', style: { marginTop: '4px' } },
            (diff.changed || []).map(c => aiChangeRow(c, 'changed'))
              .concat((diff.added || []).map(c => aiChangeRow(c, 'added')))
              .concat((diff.removed || []).map(c => aiChangeRow(c, 'removed')))
          ),

          h('div', { className: 'cgp-field', style: { marginTop: '10px' } },
            h('button', {
              className: 'btn cgp-btn', disabled: busy, onClick: () => actions.aiReview(target)
            }, 'See before / after'),
            h('button', {
              className: 'btn cgp-btn cgp-btn--primary', disabled: busy, onClick: apply
            }, 'Apply'),
            h('button', {
              className: 'btn cgp-btn', disabled: busy, onClick: discard
            }, 'Discard')
          ),

          h('p', { className: 'cgp-sub', style: { marginTop: '6px' } },
            'Apply saves it as an unstaged change in Source Control - review it there, ' +
            'or reopen the diagram, before making a save point.')
        )
      )
  );
}

// -------------------------------------------------------------- catalog

/**
 * The shipped BPMN patterns. Each card is copy-pasteable (the raw XML) or a
 * one-click new diagram in the repo. The element summary comes parsed from
 * the main process, so it always matches the file.
 */
export function Catalog({ catalog, actions, busy, onOpen, onInsert }) {
  const [ copiedId, setCopiedId ] = useState(null);
  const [ workingId, setWorkingId ] = useState(null);
  const [ insertedId, setInsertedId ] = useState(null);

  if (!catalog) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Loading the catalog...'));
  }

  if (catalog.error) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, catalog.error));
  }

  const entries = catalog.entries || [];

  if (!entries.length) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'The catalog is empty.'));
  }

  const copy = async entry => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(entry.xml);
      } else {
        const ta = document.createElement('textarea');
        ta.value = entry.xml;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(c => (c === entry.id ? null : c)), 1500);
    } catch (err) {
      // Clipboard blocked; leave the button as-is rather than lying.
    }
  };

  const create = async entry => {
    setWorkingId(entry.id);
    const res = await actions.catalogNew(entry.id, entry.title);
    setWorkingId(null);
    if (res && res.path) onOpen(res.path);
  };

  const addToEditor = entry => {
    if (!onInsert) return;
    onInsert(entry.xml);
    setInsertedId(entry.id);
    setTimeout(() => setInsertedId(c => (c === entry.id ? null : c)), 1500);
  };

  return h('div', { className: 'cgp-panel' },
    h('p', { className: 'cgp-eyebrow' },
      `${entries.length} ready-made pattern${entries.length === 1 ? '' : 's'} - preview it, drop it into the open diagram, or start a new one`),

    h('div', { className: 'cgp-cat__grid' },
      entries.map(entry => h('div', { key: entry.id, className: 'cgp-cat__card' },
        h('div', { className: 'cgp-cat__head' },
          h('span', { className: 'cgp-cat__title' }, entry.title),
          entry.category && h('span', { className: 'cgp-cat__cat' }, entry.category)
        ),

        h('p', { className: 'cgp-cat__desc' }, entry.description),

        entry.elements && entry.elements.length
          ? h('div', { className: 'cgp-cat__els' },
            entry.elements.slice(0, 8).map((el, i) => h('span', { key: i, className: 'cgp-cat__el' },
              h('span', { className: 'cgp-cat__eltype' }, TYPE_LABEL(el.type)),
              el.name ? h('span', { className: 'cgp-cat__elname' }, ` “${el.name}”`) : null
            )))
          : null,

        h('div', { className: 'cgp-cat__actions' },
          h('button', {
            className: 'btn cgp-btn',
            disabled: busy,
            title: 'See this diagram in a viewer',
            onClick: () => actions.catalogPreview(entry.id)
          }, 'Preview'),

          onInsert && h('button', {
            className: 'btn cgp-btn cgp-btn--primary',
            disabled: busy,
            title: 'Drop this straight into the diagram open in the editor',
            onClick: () => addToEditor(entry)
          }, insertedId === entry.id ? 'Added ✓' : 'Add to editor'),

          h('button', {
            className: 'btn cgp-btn',
            disabled: busy || workingId === entry.id,
            title: 'Add this as a new .bpmn in your project and open it',
            onClick: () => create(entry)
          }, workingId === entry.id ? 'Creating…' : 'New file'),

          h('button', {
            className: 'btn cgp-btn',
            disabled: busy,
            title: 'Copy the BPMN XML to the clipboard',
            onClick: () => copy(entry)
          }, copiedId === entry.id ? 'Copied!' : 'Copy XML')
        )
      ))
    )
  );
}

// -------------------------------------------------------- merge requests

/**
 * Open pull/merge requests, with the conflicting ones raised to the top and
 * a one-click path into resolving them *here* rather than in the host's web
 * conflict editor - which cannot show a diagram at all.
 */
export function MergeRequests({ data, actions, busy }) {
  if (!data) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Loading merge requests...'));
  }

  if (data.error) {
    return h('div', { className: 'cgp-panel' },
      h('div', { className: 'cgp-notice cgp-notice--warn' },
        h('div', { className: 'cgp-notice__title' }, 'Could not load merge requests'),
        h('div', { className: 'cgp-notice__body' }, data.error),
        h('div', { className: 'cgp-notice__body cgp-sub' },
          'A private project needs a token - add one under Git Settings.')));
  }

  if (!data.supported) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' },
        `The team server (${data.host || 'this host'}) is not GitHub or GitLab, ` +
        'so merge requests are not available here.'));
  }

  const items = data.items || [];
  const provider = data.provider || 'the server';

  return h('div', { className: 'cgp-panel' },
    h('div', { className: 'cgp-toolbar' },
      h('span', { className: 'cgp-eyebrow' },
        items.length
          ? `${items.length} open on ${provider}`
          : `Nothing open on ${provider}`),
      h('span', { className: 'cgp-toolbar__spacer' }),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: actions.refreshMergeRequests
      }, h(Icon, { name: 'Renew', size: 13 }), ' Refresh')
    ),

    !items.length
      ? h('p', { className: 'cgp-empty' }, 'No open merge requests right now.')
      : h('ul', { className: 'cgp-mr-list' },
        items.map(mr => h('li', { key: `${mr.number}`, className: 'cgp-mr' },
          h('div', { className: 'cgp-mr__top' },
            h('span', { className: 'cgp-mr__num' }, `#${mr.number}`),
            // The title is the way into the review: all changed files, each
            // diagram before and after with synced zoom.
            h('span', {
              className: 'cgp-mr__title cgp-mr__title--link',
              title: 'See every changed file, before and after',
              onClick: () => actions.reviewMr(mr.source, mr.target)
            }, mr.title),
            mr.draft && h('span', { className: 'cgp-chip cgp-chip--muted' }, 'Draft')
          ),

          h('div', { className: 'cgp-mr__meta' },
            h('span', { className: 'cgp-mr__branches' },
              h('span', { className: 'cgp-mono' }, mr.source),
              ' → ',
              h('span', { className: 'cgp-mono' }, mr.target)),
            mr.isCurrent && h('span', { className: 'cgp-chip cgp-chip--current' }, 'You are here'),
            mr.author && h('span', { className: 'cgp-sub' }, `by ${mr.author}`)
          ),

          h('div', { className: 'cgp-mr__foot' },
            // The status the whole tab is really about.
            mr.hasConflicts === true
              ? h('span', { className: 'cgp-tag cgp-tag--deleted' }, 'CONFLICTS')
              : mr.hasConflicts === false
                ? h('span', { className: 'cgp-tag cgp-tag--added' }, 'MERGEABLE')
                : h('span', { className: 'cgp-tag cgp-tag--muted' }, 'UNKNOWN'),

            h('span', { className: 'cgp-toolbar__spacer' }),

            h('button', {
              className: 'btn cgp-btn',
              disabled: busy,
              title: 'See every changed file, before and after, with synced zoom',
              onClick: () => actions.reviewMr(mr.source, mr.target)
            }, 'Review changes'),

            // Offered whenever it is not known to be clean: conflicts, or an
            // unknown state the merge itself will settle.
            mr.hasConflicts !== false && h('button', {
              className: 'btn cgp-btn cgp-btn--primary',
              disabled: busy,
              title: 'Bring both branches together here and resolve each diagram visually',
              onClick: () => actions.resolveMr(mr.source, mr.target)
            }, 'Resolve in Modeler'),

            h('button', {
              className: 'btn cgp-btn',
              disabled: busy,
              title: `Open this on ${provider}`,
              onClick: () => actions.openUrl(mr.url)
            }, `Open on ${provider}`)
          )
        ))
      )
  );
}

// -------------------------------------------------------------- conflicts

export function ConflictResolver({ conflicts, resolved, actions, busy, context }) {
  const remaining = conflicts.length;
  const decided = (resolved || []).length;
  const total = remaining + decided;

  // "ours" is whatever is checked out, which is your workstream when
  // getting updates but the *shared version* when finishing one - and
  // during a rebase it is the other branch entirely, because your commits
  // are the ones being replayed. Labelling by branch name is unambiguous in
  // every direction; "Keep mine" is wrong in two of them.
  //
  // The readable form comes from the main process (conflict-service
  // `titleOf`), with the raw branch name as a fallback. It used to call a
  // `humanizeBranch` that was never defined or imported here - which threw
  // only once a merge was actually in progress, so the whole panel died at
  // the exact moment it was needed most.
  const ctx = context || {};
  const oursName = ctx.oursTitle || ctx.ours || 'this version';
  const theirsName = ctx.theirsTitle || ctx.theirs || 'the other version';

  const operation = (context && context.operation) || null;
  const inverted = !!(context && context.inverted);

  return h('div', null,
    h('div', { className: 'cgp-notice cgp-notice--warn' },
      h('div', { className: 'cgp-notice__title' },
        remaining ? 'The same diagrams were changed twice' : 'All decisions made'
      ),
      h('div', { className: 'cgp-notice__body' },
        remaining
          ? `Choose which version of each diagram to keep - "${oursName}" or "${theirsName}". Open both first if you are not sure.`
          : 'Nothing is conflicted any more. Finish up to complete this.'
      ),

      // What is actually half-finished. It is usually a merge, but the
      // console can leave a rebase or a cherry-pick open, and those behave
      // differently enough that saying "merge" would be a lie.
      operation && h('div', { className: 'cgp-notice__body cgp-sub' },
        `This started while ${operation.label}.`
      ),

      // During a rebase your work is the incoming side. Someone who reads
      // "ours" as "mine" here discards their own changes believing they
      // kept them, so it is stated rather than implied.
      inverted && h('div', { className: 'cgp-notice__body cgp-sub--warn' },
        `Note: your own changes are the "${theirsName}" side here, because ` +
        'they are being replayed on top of the other version.'
      )
    ),

    total > 1 && h('p', { className: 'cgp-eyebrow' },
      `${decided} of ${total} decided`
    ),

    h('ul', { className: 'cgp-list' },
      conflicts.map(c => h('li', {
        key: c.path,
        style: { padding: '8px 0', borderBottom: '1px solid var(--cgp-line)' }
      },
        h('div', null, prettyName(c.name)),
        c.deletedBy && h('div', { className: 'cgp-sub', style: { color: 'var(--cgp-deleted)' } },
          c.deletedBy === 'them'
            ? `"${theirsName}" deleted this diagram - keeping it removes the file.`
            : c.deletedBy === 'us'
              ? `"${oursName}" deleted this diagram - keeping it removes the file.`
              : 'Both versions deleted this diagram.'
        ),

        // When the two sides changed different things, keeping a whole side
        // throws the other side's work away - which is exactly the case
        // combining exists for, so it is called out rather than left as an
        // equal-looking third button.
        c.combinable && h('div', { className: 'cgp-sub', style: { color: 'var(--cgp-added)' } },
          'These changes do not clash - they can be combined without losing either side.'
        ),

        h('div', { className: 'cgp-field', style: { marginTop: '5px' } },
          c.combinable && h('button', {
            className: 'btn cgp-btn cgp-btn--primary',
            disabled: busy,
            title: 'Merge both sets of changes into one diagram. Nothing is discarded.',
            onClick: () => actions.combine(c.path)
          }, 'Combine both'),
          c.isDiagram && c.hasOurs && c.hasTheirs && h('button', {
            className: 'btn cgp-btn',
            disabled: busy,
            title: 'Open both versions side by side',
            onClick: () => actions.compare(c.path)
          }, 'Show me both'),
          h('button', {
            className: 'btn cgp-btn', disabled: busy,
            title: `Keep the version from "${oursName}"`,
            onClick: () => actions.resolve(c.path, 'mine')
          }, `Keep ${oursName}`),
          h('button', {
            className: 'btn cgp-btn', disabled: busy,
            title: `Keep the version from "${theirsName}"`,
            onClick: () => actions.resolve(c.path, 'theirs')
          }, `Keep ${theirsName}`)
        )
      ))
    ),

    // Decisions already made, each with a way back. Without this the list
    // just shrinks with no undo, so the only way to change your mind about
    // one file is to abort everything and start again - which is enough of
    // a cliff that people press Finish on a choice they know is wrong.
    decided > 0 && h('details', { style: { marginTop: '10px' } },
      h('summary', { style: { cursor: 'pointer', fontSize: '12px' } },
        `Already decided (${decided})`
      ),
      h('ul', { className: 'cgp-list', style: { marginTop: '6px' } },
        (resolved || []).map(r => h('li', { key: r.path, className: 'cgp-row' },
          h('span', { className: 'cgp-row__name', title: r.path },
            prettyName(r.name),
            r.removed && h('span', { className: 'cgp-row__meta' }, '  (removed)')
          ),
          h('span', { className: 'cgp-row__actions' },
            h('button', {
              className: 'btn cgp-btn',
              disabled: busy,
              title: 'Put this file back to needing a decision',
              onClick: () => actions.undoResolution(r.path)
            }, 'Change my mind')
          )
        ))
      )
    ),

    h('div', { className: 'cgp-field', style: { marginTop: '12px' } },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary',
        disabled: busy || remaining > 0,
        title: remaining
          ? `${remaining} diagram(s) still need a decision`
          : 'Complete this and carry on',
        onClick: actions.completeMerge
      }, 'Finish'),
      h('button', {
        className: 'btn cgp-btn',
        disabled: busy,
        title: (operation && operation.startOver) ||
          'Undo this entirely. Your own saved work is not affected.',
        onClick: actions.abortMerge
      }, 'Start over')
    ),

    operation && h('p', { className: 'cgp-sub' }, operation.startOver)
  );
}

// ------------------------------------------------------------- file rows

export function FileRow({ file, actions, busy }) {
  const { word, tone, code } = statusWord(file);
  const slash = file.path.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.path.slice(0, slash);

  return h('li', {
    className: 'cgp-row',
    title: `${file.path}  (git status: ${code})`
  },
    h('span', { className: `cgp-tag cgp-tag--${tone}` }, word),
    h('span', { className: 'cgp-row__name' }, prettyName(file.path.slice(slash + 1))),
    dir && h('span', { className: 'cgp-row__meta' }, dir),
    h('span', { className: 'cgp-row__actions' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--icon',
        disabled: busy,
        title: file.staged ? 'Remove from the next save point' : 'Include in the next save point',
        onClick: () => (file.staged ? actions.unstage(file) : actions.stage(file))
      }, file.staged ? '−' : '+')
    )
  );
}

export function Section({ title, files, actions, busy, action }) {
  if (!files.length) {
    return null;
  }

  return h('div', { style: { marginBottom: '12px' } },
    h('div', { className: 'cgp-toolbar', style: { marginBottom: '4px' } },
      h('span', { className: 'cgp-eyebrow' }, `${title} (${files.length})`),
      h('span', { className: 'cgp-toolbar__spacer' }),
      action
    ),
    h('ul', { className: 'cgp-list' },
      files.map(f => h(FileRow, { key: f.path, file: f, actions, busy }))
    )
  );
}

// --------------------------------------------------------------- explorer

function TreeFolder({ node, repoPath, onOpen, defaultOpen }) {
  const [ open, setOpen ] = useState(defaultOpen);

  const changedInside = countChanged(node);

  return h('li', null,
    h('div', {
      className: 'cgp-folder',
      onClick: () => setOpen(!open),
      title: node.path
    },
      h('span', { className: `cgp-caret ${open ? 'cgp-caret--open' : ''}` }, '▶'),
      h('span', { className: 'cgp-row__name' }, node.name),
      changedInside > 0 && !open && h('span', { className: 'cgp-dot', title: `${changedInside} changed` })
    ),
    open && h(TreeLevel, { node, repoPath, onOpen })
  );
}

function countChanged(node) {
  const here = node.files.filter(f => f.changed).length;
  return node.folders.reduce((sum, f) => sum + countChanged(f), here);
}

function TreeLevel({ node, repoPath, onOpen }) {
  return h('ul', { className: 'cgp-tree' },
    node.folders.map(f => h(TreeFolder, {
      key: f.path, node: f, repoPath, onOpen, defaultOpen: countChanged(f) > 0
    })),
    node.files.map(f => h('li', { key: f.path },
      h('div', {
        className: `cgp-file ${f.changed ? 'cgp-file--changed' : ''}`,
        title: f.path,
        onClick: () => onOpen(f)
      },
        h('span', { className: 'cgp-ext' }, f.extension),
        h('span', { className: 'cgp-file__name' }, f.title),
        f.changed && h('span', { className: 'cgp-dot', title: 'Changed' })
      )
    ))
  );
}

export function Explorer({ tree, onOpen, onRefresh, busy }) {
  if (!tree) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Loading diagrams...')
    );
  }

  if (tree.error) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, tree.error)
    );
  }

  const empty = !tree.total;

  return h('div', { className: 'cgp-panel' },
    h('div', { className: 'cgp-toolbar' },
      h('span', { className: 'cgp-eyebrow' },
        empty ? 'No diagrams found' : `${tree.total} diagrams · ${tree.changed} changed`
      ),
      h('span', { className: 'cgp-toolbar__spacer' }),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: onRefresh
      }, 'Refresh')
    ),

    empty
      ? h('p', { className: 'cgp-empty' },
        'No .bpmn, .dmn or .form files in this project yet.')
      : h(TreeLevel, { node: tree.tree, repoPath: tree.repoPath, onOpen })
  );
}

// --------------------------------------------------------------- activity

function clockTime(ms) {
  const d = new Date(ms);
  return [ d.getHours(), d.getMinutes(), d.getSeconds() ]
    .map(n => String(n).padStart(2, '0')).join(':');
}

/**
 * One command's output, revealed on demand.
 *
 * Collapsed by default: the log is read by scanning for the command that
 * went wrong, and expanding two hundred `git status` dumps inline would
 * bury it. A failed command starts open, because its output is the reason
 * anyone opened this tab.
 */
function Output({ entry }) {
  const [ open, setOpen ] = useState(!entry.ok);

  const stdout = entry.stdout || '';
  const stderr = entry.stderr || '';

  if (!stdout && !stderr) {
    return null;
  }

  const lines = (stdout + stderr).split('\n').length;

  return h('div', { className: 'cgp-log__output' },
    h('button', {
      className: 'cgp-log__toggle',
      onClick: () => setOpen(!open),
      title: open ? 'Hide the output' : 'Show what this command answered'
    }, `${open ? '▾' : '▸'} ${lines} line${lines === 1 ? '' : 's'} of output`),

    open && h('pre', { className: 'cgp-log__pre' },
      stdout && h('span', null, stdout),

      // git puts progress and hints on stderr even when it succeeds, so
      // this is not necessarily an error - it is just the other stream.
      stderr && h('span', { className: 'cgp-log__stderr' },
        (stdout ? '\n' : '') + stderr)
    )
  );
}

const ORIGIN_LABELS = { auto: 'auto', console: 'you' };

/**
 * The command log, shown as a shell transcript, with a prompt.
 *
 * Deliberately reads like a terminal: this is the one place in the plugin
 * that speaks git rather than translating it, because its whole purpose is
 * to show exactly what ran - now including what each command answered, and
 * letting a developer type their own.
 *
 * The prompt only appears in developer mode. Everything typed lands in the
 * same list as the automatic commands, tagged `you`, so the transcript
 * stays a single honest account of what happened to the repository.
 */
export function Activity({ entries, onRefresh, onClear, onRun, consoleEnabled, busy }) {
  const [ filter, setFilter ] = useState('all');
  const [ line, setLine ] = useState('');

  // Shell-style recall. Index counts back from the newest; -1 is the live
  // input, which is preserved so Down returns you to what you were typing.
  const [ recall, setRecall ] = useState(-1);
  const [ draft, setDraft ] = useState('');

  const all = entries || [];
  const typed = all.filter(e => e.origin === 'console');

  const rows = filter === 'all' ? all : all.filter(e => e.origin === filter);
  const failed = rows.filter(e => !e.ok).length;
  const failedAll = all.filter(e => !e.ok).length;

  const submit = () => {
    const command = line.trim();

    if (!command || busy) {
      return;
    }

    setLine('');
    setDraft('');
    setRecall(-1);
    onRun(command);
  };

  const onKeyDown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();

      if (!typed.length) return;

      const next = Math.min(recall + 1, typed.length - 1);

      if (recall === -1) setDraft(line);

      setRecall(next);
      setLine(typed[next].command.replace(/^git /, ''));
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();

      if (recall <= 0) {
        setRecall(-1);
        setLine(draft);
        return;
      }

      const next = recall - 1;
      setRecall(next);
      setLine(typed[next].command.replace(/^git /, ''));
    }
  };

  const stat = (n, labelText, kind) => h('div', { className: 'cgp-stat' },
    h('span', {
      className: 'cgp-stat__num cgp-stat__num--' + (n ? kind : 'zero')
    }, String(n || 0)),
    h('span', { className: 'cgp-stat__label' }, labelText)
  );

  return h('div', { className: 'cgp-panel' },

    // Same opening hero as every other tab: what this is, whether anything
    // went wrong, and the counts worth a glance before reading the log.
    h('div', { className: 'cgp-hero' },
      h('div', { className: 'cgp-hero__main' },
        h('span', { className: 'cgp-hero__eyebrow' }, 'Activity'),
        h('div', { className: 'cgp-hero__line' },
          h('span', { className: 'cgp-hero__version', style: { fontSize: '17px' } }, 'Command log'),
          failedAll
            ? h('span', { className: 'cgp-pill cgp-pill--warn' },
              `${failedAll} failed`)
            : h('span', { className: 'cgp-pill cgp-pill--live' }, 'All ran')
        )
      ),
      h('div', { className: 'cgp-stats' },
        stat(all.length, 'Commands', 'queued'),
        stat(failedAll, 'Failed', 'flight'),
        stat(typed.length, 'By you', 'flight')
      )
    ),

    h('div', { className: 'cgp-toolbar' },
      h('span', { className: 'cgp-eyebrow' },
        `${rows.length} command${rows.length === 1 ? '' : 's'}`,
        failed > 0 && h('span', { className: 'cgp-failcount' }, `${failed} failed`)
      ),
      h('span', { className: 'cgp-toolbar__spacer' }),

      h('select', {
        className: 'cgp-select',
        value: filter,
        disabled: busy,
        onChange: e => setFilter(e.target.value)
      },
        h('option', { value: 'all' }, 'Everything'),
        h('option', { value: 'auto' }, 'Background only'),
        h('option', { value: 'console' }, 'Typed by me')
      ),

      h('button', { className: 'btn cgp-btn', disabled: busy, onClick: onRefresh }, 'Refresh'),
      h('button', { className: 'btn cgp-btn', disabled: busy, onClick: onClear }, 'Clear')
    ),

    !rows.length
      ? h('p', { className: 'cgp-empty' },
        filter === 'auto' ? 'Nothing has run in the background yet.'
          : filter === 'console' ? 'You have not typed any commands yet.'
            : 'No commands yet.')
      : h('ul', { className: 'cgp-log' },
        rows.map(e => h('li', {
          key: e.id,
          className: 'cgp-log__row'
            + (e.ok ? '' : ' cgp-log__row--failed')
            + (e.origin === 'console' ? ' cgp-log__row--mine' : '')
        },
          h('div', { className: 'cgp-log__line' },
            h('span', { className: 'cgp-log__time' }, clockTime(e.at)),
            h('span', {
              className: `cgp-log__origin ${e.origin === 'auto' ? 'cgp-log__origin--auto' : ''}`
            }, ORIGIN_LABELS[e.origin] || ''),
            h('span', { className: 'cgp-log__cmd' }, e.command),
            h('span', { className: 'cgp-log__ms' }, `${e.durationMs}ms`),
            !e.ok && h('span', { className: 'cgp-tag cgp-tag--deleted' }, 'failed')
          ),

          !e.ok && e.error && h('p', { className: 'cgp-log__error' }, e.error),

          h(Output, { entry: e })
        ))
      ),

    consoleEnabled
      ? h('div', { className: 'cgp-console' },
        h('span', { className: 'cgp-console__prompt' }, 'git'),
        h('input', {
          className: 'cgp-console__input',
          value: line,
          disabled: busy,
          spellCheck: false,
          autoComplete: 'off',
          placeholder: 'status  ·  stash  ·  reset --hard HEAD  ·  ↑ for history',
          onChange: e => { setLine(e.target.value); setRecall(-1); },
          onKeyDown
        }),
        h('button', {
          className: 'btn cgp-btn', disabled: busy || !line.trim(), onClick: submit
        }, 'Run')
      )
      : h('p', { className: 'cgp-console__off' },
        'Turn on "Developer mode" in Git Settings to run git commands here.'
      )
  );
}

// --------------------------------------------------------------- settings

/**
 * The team's settings - the ones that live in the repository rather than on
 * this machine.
 *
 * Kept visibly separate from everything else in this tab, and worded that
 * way throughout, because the consequence of changing them lands on
 * everybody. It follows the same preview-then-apply contract as the
 * routines: nothing is written until the plan has been shown.
 */
function ProjectSetup({ setup, actions, busy }) {
  const [ draft, setDraft ] = useState(null);
  const [ plan, setPlan ] = useState(null);
  const [ error, setError ] = useState(null);

  if (!setup) {
    return null;
  }

  const value = draft || setup.current;
  const change = patch => {
    setDraft(Object.assign({}, value, patch));
    setPlan(null);
    setError(null);
  };

  const gitflow = value.branchModel === 'gitflow';

  const branchPicker = (label, key, hint) => h('div', { className: 'cgp-field', style: { marginBottom: '6px' } },
    h('span', { className: 'cgp-row__meta', style: { minWidth: '110px' }, title: hint }, label),
    h('select', {
      className: 'cgp-select',
      value: value[key] || '',
      disabled: busy,
      onChange: e => change({ [key]: e.target.value })
    },
      h('option', { value: '' }, 'Choose a branch...'),
      (setup.branches || []).map(b => h('option', { key: b, value: b }, b))
    )
  );

  const preview = async () => {
    setError(null);

    const result = await actions.previewProjectSetup(value);

    if (result && result.error) {
      setError(result.error);
      setPlan(null);
      return;
    }

    setPlan(result);
  };

  const apply = async () => {
    await actions.applyProjectSetup(plan.projectSettings);
    setPlan(null);
    setDraft(null);
  };

  return h('div', { className: 'cgp-block cgp-block--team' },
    h('p', { className: 'cgp-block__title' }, 'How this project is organised'),

    setup.guessing
      ? h('p', { className: 'cgp-sub' },
        'Nobody has set this project up yet, so the plugin is working it out ' +
        'from the branch names. Writing it down means everyone on the team ' +
        'agrees - including people who have not opened it yet.')
      : h('p', { className: 'cgp-sub' },
        `Shared with the team through ${setup.file}` +
        (setup.committed ? '.' : ' - not saved and sent yet, so only you have it.')),

    setup.warning && h('p', { className: 'cgp-sub cgp-sub--warn' }, setup.warning),

    (setup.models || []).map(m => h('label', {
      key: m.id,
      className: 'cgp-radio',
      title: m.hint
    },
      h('input', {
        type: 'radio',
        name: 'cgp-branch-model',
        checked: value.branchModel === m.id,
        disabled: busy,
        style: { marginRight: '6px' },
        onChange: () => change({ branchModel: m.id })
      }),
      h('span', null, m.label),
      h('span', { className: 'cgp-sub', style: { display: 'block', marginLeft: '20px' } }, m.hint)
    )),

    h('div', { style: { marginTop: '8px' } },
      branchPicker(
        gitflow ? 'Everyday work' : 'Shared branch',
        'baseBranch',
        'Where new work starts from and returns to'
      ),
      gitflow && branchPicker(
        'What is live',
        'releaseBranch',
        'Urgent fixes start from here, so it must be what is actually released'
      )
    ),

    h('div', { className: 'cgp-field', style: { marginBottom: '6px' } },
      h('span', { className: 'cgp-row__meta', style: { minWidth: '110px' } }, 'Ticket prefix'),
      h('input', {
        type: 'text', className: 'cgp-input cgp-input--ticket',
        value: value.jiraProjectKey || '', disabled: busy,
        onChange: e => change({ jiraProjectKey: e.target.value.toUpperCase() })
      })
    ),

    h('div', { className: 'cgp-field', style: { marginBottom: '6px' } },
      h('span', { className: 'cgp-row__meta', style: { minWidth: '110px' } }, 'Jira address'),
      h('input', {
        type: 'text', className: 'cgp-input',
        placeholder: 'jira.example.com - optional, makes ticket numbers clickable',
        value: value.jiraHost || '', disabled: busy,
        onChange: e => change({ jiraHost: e.target.value })
      })
    ),

    error && h('p', { className: 'cgp-sub cgp-sub--warn' }, error),

    plan
      ? h('div', { className: 'cgp-plan' },
        h('p', { className: 'cgp-eyebrow' }, 'This will:'),
        h('ol', { className: 'cgp-plan__steps' },
          plan.steps.map(s => h('li', { key: s.key }, s.label))
        ),
        (plan.warnings || []).map((w, i) =>
          h('p', { key: i, className: 'cgp-sub cgp-sub--warn' }, w)),
        h('div', { className: 'cgp-field' },
          h('button', {
            className: 'btn cgp-btn', disabled: busy, onClick: apply
          }, 'Save these settings'),
          h('button', {
            className: 'btn cgp-btn', disabled: busy, onClick: () => setPlan(null)
          }, 'Cancel')
        )
      )
      : h('button', {
        className: 'btn cgp-btn', disabled: busy, onClick: preview
      }, setup.exists ? 'Review changes' : 'Set this project up')
  );
}

export function Settings({ settings, projectSetup, autoPull, blockedReason, actions, busy }) {
  const [ draft, setDraft ] = useState(null);
  const [ githubToken, setGithubToken ] = useState('');
  const [ gitlabToken, setGitlabToken ] = useState('');
  const [ openRouterKey, setOpenRouterKey ] = useState('');

  if (!settings) {
    return h('div', { className: 'cgp-panel' },
      h('p', { className: 'cgp-empty' }, 'Loading settings...'));
  }

  // `autoPull` is defaulted rather than assumed. A response that is missing
  // it should degrade to an unchecked box, not throw during render - an
  // exception here takes down every tab in the panel, not just this one.
  const raw = draft || settings;
  const value = Object.assign({}, raw, {
    autoPull: Object.assign({ enabled: false, intervalMinutes: 15 }, raw.autoPull)
  });

  const change = patch => setDraft(Object.assign({}, value, patch));

  const save = () => {
    const payload = Object.assign({}, draft || {});

    // Only send tokens the user actually typed - an untouched box must
    // never clear a stored token.
    if (githubToken) payload.githubToken = githubToken;
    if (gitlabToken) payload.gitlabToken = gitlabToken;
    if (openRouterKey) payload.openRouterKey = openRouterKey;

    actions.saveSettings(payload);
    setDraft(null);
    setGithubToken('');
    setGitlabToken('');
    setOpenRouterKey('');
  };

  const dirty = !!draft || !!githubToken || !!gitlabToken || !!openRouterKey;

  return h('div', { className: `cgp-panel ${busy ? 'cgp-busy' : ''}` },

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'Project folder'),
      h('div', { className: 'cgp-field' },
        h('input', {
          type: 'text',
          className: 'cgp-input',
          value: value.repoPath || '',
          placeholder: 'No folder selected',
          readOnly: true
        }),
        h('button', {
          className: 'btn cgp-btn', disabled: busy, onClick: actions.pickFolder
        }, 'Choose...')
      ),
      h('p', { className: 'cgp-sub' },
        'The folder containing your diagrams. It should already be set up for the team.')
    ),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'Get updates automatically'),
      h('label', { className: 'cgp-field', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: value.autoPull.enabled,
          disabled: busy,
          onChange: e => change({
            autoPull: Object.assign({}, value.autoPull, { enabled: e.target.checked })
          })
        }),
        h('span', null, 'Check for the team\'s updates in the background')
      ),
      value.autoPull.enabled && h('div', { className: 'cgp-field', style: { marginTop: '8px' } },
        h('span', { className: 'cgp-row__meta' }, 'Every'),
        h('input', {
          type: 'number',
          className: 'cgp-input',
          style: { maxWidth: '70px', flex: '0 0 auto' },
          min: 1, max: 240,
          value: value.autoPull.intervalMinutes,
          disabled: busy,
          onChange: e => change({
            autoPull: Object.assign({}, value.autoPull, { intervalMinutes: e.target.value })
          })
        }),
        h('span', { className: 'cgp-row__meta' }, 'minutes')
      ),
      h('p', { className: 'cgp-sub' },
        'Only runs when everything is saved and no decisions are pending, so it ' +
        'can never interrupt you. Everything it does appears in Activity.'),
      blockedReason && h('p', { className: 'cgp-sub', style: { color: 'var(--cgp-edited)' } },
        `Currently: ${blockedReason}`),
      h('button', {
        className: 'btn cgp-btn', disabled: busy, style: { marginTop: '6px' },
        onClick: actions.autoPullNow
      }, 'Check now')
    ),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'When someone finishes a workstream'),
      [
        [ 'review', 'Review first', 'Opens a review request. Someone checks the diagrams before they reach the shared version.' ],
        [ 'direct', 'Combine directly', 'Finished work goes straight in. Faster, but nothing is checked first.' ]
      ].map(([ id, title, note ]) => h('label', {
        key: id,
        style: { display: 'block', cursor: 'pointer', marginBottom: '6px' }
      },
        h('input', {
          type: 'radio',
          name: 'cgp-merge-policy',
          checked: value.mergePolicy === id,
          disabled: busy,
          style: { marginRight: '6px' },
          onChange: () => change({ mergePolicy: id })
        }),
        h('span', null, title),
        h('span', { className: 'cgp-sub', style: { display: 'block', marginLeft: '20px' } }, note)
      ))
    ),

    h(ProjectSetup, { setup: projectSetup, actions, busy }),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'Developer mode'),
      h('label', { className: 'cgp-row__meta', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: !!value.developerMode,
          disabled: busy,
          style: { marginRight: '6px' },
          onChange: e => change({ developerMode: e.target.checked })
        }),
        h('span', null, 'Let me type git commands in the Activity tab')
      ),
      h('p', { className: 'cgp-sub', style: { marginLeft: '20px' } },
        'Runs whatever you type against this project, including commands ' +
        'that can throw work away. There is no confirmation and no undo - ' +
        'leave this off unless you use git directly.'
      )
    ),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'Team server (optional)'),
      h('div', { className: 'cgp-field', style: { marginBottom: '8px' } },
        h('span', { className: 'cgp-row__meta', style: { minWidth: '90px' } }, 'GitLab host'),
        h('input', {
          type: 'text', className: 'cgp-input', value: value.gitlabHost || '',
          disabled: busy, onChange: e => change({ gitlabHost: e.target.value })
        })
      ),
      h('div', { className: 'cgp-field', style: { marginBottom: '8px' } },
        h('span', { className: 'cgp-row__meta', style: { minWidth: '90px' } }, 'GitHub token'),
        h('input', {
          type: 'password', className: 'cgp-input',
          placeholder: settings.hasGithubToken ? 'saved' : 'not set',
          value: githubToken, disabled: busy,
          onChange: e => setGithubToken(e.target.value)
        })
      ),
      h('div', { className: 'cgp-field' },
        h('span', { className: 'cgp-row__meta', style: { minWidth: '90px' } }, 'GitLab token'),
        h('input', {
          type: 'password', className: 'cgp-input',
          placeholder: settings.hasGitlabToken ? 'saved' : 'not set',
          value: gitlabToken, disabled: busy,
          onChange: e => setGitlabToken(e.target.value)
        })
      ),
      h('p', { className: 'cgp-sub' },
        'Only needed for listing issues on private projects. Stored in plain ' +
        'text in your home folder - treat them as low-value tokens.')
    ),

    h('div', { className: 'cgp-block' },
      h('p', { className: 'cgp-block__title' }, 'AI edits (OpenRouter)'),
      h('div', { className: 'cgp-field', style: { marginBottom: '8px' } },
        h('span', { className: 'cgp-row__meta', style: { minWidth: '90px' } }, 'API key'),
        h('input', {
          type: 'password', className: 'cgp-input',
          placeholder: settings.hasOpenRouterKey ? 'saved' : 'not set',
          value: openRouterKey, disabled: busy,
          onChange: e => setOpenRouterKey(e.target.value)
        })
      ),
      h('div', { className: 'cgp-field' },
        h('span', { className: 'cgp-row__meta', style: { minWidth: '90px' } }, 'Model'),
        h('input', {
          type: 'text', className: 'cgp-input',
          placeholder: 'anthropic/claude-sonnet-4.5',
          value: value.openRouterModel || '', disabled: busy,
          onChange: e => change({ openRouterModel: e.target.value })
        })
      ),
      h('p', { className: 'cgp-sub' },
        'Used by the AI Edit tab. Your diagram and instruction are sent to ' +
        'OpenRouter when you preview an edit. The key is stored in plain text ' +
        'in your home folder, like the tokens above.')
    ),

    h('div', { className: 'cgp-field' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--primary', disabled: busy || !dirty, onClick: save
      }, 'Save settings'),
      dirty && h('button', {
        className: 'btn cgp-btn', disabled: busy,
        onClick: () => {
          setDraft(null); setGithubToken(''); setGitlabToken(''); setOpenRouterKey('');
        }
      }, 'Discard')
    )
  );
}



// ------------------------------------------------------------ scm rows

/**
 * A file row in the VS Code Source Control idiom: name, dimmed folder,
 * single status letter on the right, actions on hover.
 *
 * The plain letter is used here rather than the word ("Edited") that the
 * step-by-step list shows - this pane is dense, and the letter is what the
 * layout it copies uses. The word is still in the tooltip.
 */
export function ScmRow({ file, actions, busy }) {
  const { word, code } = statusWord(file);
  const slash = file.path.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.path.slice(0, slash);
  const name = file.path.slice(slash + 1);
  const letter = code === '?' ? 'U' : code;

  return h('div', {
    className: 'cgp-scm-row',
    title: `${file.path}
${word} (git status: ${code})`
  },
    h('span', { className: 'cgp-scm-row__name' }, prettyName(name)),
    h('span', { className: 'cgp-scm-row__dir' }, dir),
    h('span', { className: 'cgp-row__actions' },
      h('button', {
        className: 'btn cgp-btn cgp-btn--icon',
        disabled: busy,
        title: file.staged ? 'Remove from the next save point' : 'Include in the next save point',
        onClick: () => (file.staged ? actions.unstage(file) : actions.stage(file))
      }, file.staged ? '−' : '+')
    ),
    h('span', { className: `cgp-scm-row__code cgp-code--${letter}` }, letter)
  );
}

/**
 * The always-visible summary at the top of a work tab: what you are on, how
 * clean it is, and the three counts that decide what to do next.
 *
 * Shared between Source Control and "My work" so both read the same way and
 * the numbers cannot drift between them. It is the same shape as the Releases
 * hero, on purpose - every tab now opens with one.
 */
export function WorkHero({ label, title, status }) {

  // Status arrives null on the first paint and whenever a repository is
  // still being read. "My work" renders this before it has one, so bailing
  // out is the difference between an empty header and the whole panel
  // failing to render.
  if (!status) {
    return null;
  }

  const changeCount = (status.files || []).length;

  const stat = (n, labelText, kind) => h('div', { className: 'cgp-stat' },
    h('span', {
      className: 'cgp-stat__num cgp-stat__num--' + (n ? kind : 'zero')
    }, String(n || 0)),
    h('span', { className: 'cgp-stat__label' }, labelText)
  );

  return h('div', { className: 'cgp-hero' },
    h('div', { className: 'cgp-hero__main' },
      h('span', { className: 'cgp-hero__eyebrow' }, label),
      h('div', { className: 'cgp-hero__line' },
        h('span', { className: 'cgp-hero__version', style: { fontSize: '17px' } }, title),
        changeCount
          ? h('span', { className: 'cgp-pill cgp-pill--warn' }, `${changeCount} unsaved`)
          : h('span', { className: 'cgp-pill cgp-pill--live' }, 'All saved')
      )
    ),
    h('div', { className: 'cgp-stats' },
      stat(status.behind, 'To get', 'queued'),
      stat(status.ahead, 'To send', 'flight'),
      stat(changeCount, 'Unsaved', 'flight')
    )
  );
}

/**
 * The left column: commit box, then the changed files grouped by whether
 * they are staged.
 */
export function ChangesPane({ status, actions, busy }) {
  const [ message, setMessage ] = useState('');

  const files = (status && status.files) || [];
  const staged = files.filter(f => f.staged);
  const unstaged = files.filter(f => !f.staged);

  const canCommit = !!message.trim() && staged.length > 0 && !busy;

  const commit = () => {
    if (!canCommit) return;
    actions.commit(message);
    setMessage('');
  };

  return h('div', null,
    h('textarea', {
      className: 'cgp-msg',
      rows: 2,
      value: message,
      placeholder: 'Message (Ctrl+Enter to save)',
      disabled: busy,
      onChange: e => setMessage(e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
      }
    }),

    h('button', {
      className: 'btn cgp-btn cgp-commit-btn',
      disabled: !canCommit,
      title: staged.length
        ? `Save ${staged.length} file(s) as a new save point`
        : 'Include some files first, using the + buttons',
      onClick: commit
    }, `✓  Save point${staged.length ? ` (${staged.length})` : ''}`),

    staged.length > 0 && h('div', { style: { marginTop: '12px' } },
      h('p', { className: 'cgp-split__title' },
        h('span', null, 'Ready to save'),
        h('span', { className: 'cgp-badge' }, staged.length)
      ),
      staged.map(f => h(ScmRow, { key: f.path, file: f, actions, busy }))
    ),

    h('div', { style: { marginTop: '12px' } },
      h('p', { className: 'cgp-split__title' },
        h('span', null, 'Changes'),
        h('span', { className: 'cgp-badge' }, unstaged.length),
        h('span', { style: { flex: 1 } }),
        unstaged.length > 0 && h('button', {
          className: 'btn cgp-btn cgp-btn--icon',
          disabled: busy,
          title: 'Include every change',
          onClick: actions.stageAll
        }, '+')
      ),
      unstaged.length
        ? unstaged.map(f => h(ScmRow, { key: f.path, file: f, actions, busy }))
        : h('p', { className: 'cgp-empty' }, 'No changes. Everything is saved.')
    )
  );
}
