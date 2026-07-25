/**
 * Turns raw git errors into something a process analyst can act on.
 *
 * Git's error text is written for people who already understand git's
 * model. "refusing to merge unrelated histories" is precise, useless to
 * the reader, and describes a one-command fix. Every entry here therefore
 * answers three questions:
 *
 *   what happened (title)   - in the reader's vocabulary
 *   why (detail)            - the cause, not the mechanism
 *   what now (fix)          - an offered action, when one is safe
 *
 * A `fix` is only attached when applying it cannot lose work. Anything
 * destructive is left to a human with an explanation instead.
 */

'use strict';

const PATTERNS = [
  {
    // A conflict is not a failure - it is the resolver's cue. Callers that
    // know they were merging report it themselves; this catches any path
    // that does not, so it can never surface as "Something went wrong".
    match: /^CONFLICT|\bCONFLICT \(|automatic merge failed|fix conflicts and then commit/im,
    title: 'The same diagrams were changed twice',
    detail:
      'You and the team both changed the same diagrams, so they cannot be ' +
      'combined automatically. Nothing is lost - choose which version to ' +
      'keep, then finish up.',
    fix: null
  },
  {
    match: /refusing to merge unrelated histories/i,
    title: 'These two projects were started separately',
    detail:
      'Your copy and the team\'s copy do not share a common starting point, ' +
      'so they cannot be combined automatically. This normally happens when ' +
      'the project was created here and on the server independently.',
    fix: {
      id: 'allow-unrelated',
      label: 'Combine them anyway',
      note: 'Joins the two histories together. You can still undo the merge afterwards.'
    }
  },
  {
    match: /need to specify how to reconcile divergent branches|divergent branches/i,
    title: 'You and the team both made changes',
    detail:
      'You have save points the team does not have, and they have some you ' +
      'do not. They need to be combined before anything can be sent.',
    fix: {
      id: 'merge-divergent',
      label: 'Combine both sets of changes',
      note: 'Keeps everyone\'s work and merges it together.'
    }
  },
  {
    match: /local changes.*would be overwritten|commit your changes or stash them/i,
    title: 'You have unsaved changes in the way',
    detail:
      'The team\'s updates cannot be downloaded while you have changed ' +
      'diagrams that are not saved yet - they would be overwritten.',
    fix: {
      id: 'save-then-pull',
      label: 'Save my work first, then get updates',
      note: 'Creates a save point from your changes, then downloads the team\'s.'
    }
  },
  {
    match: /no tracking information for the current branch|no upstream configured for branch/i,
    title: 'This workstream is not linked to the server yet',
    detail:
      'Nothing on the team server is marked as this workstream\'s counterpart, ' +
      'so there is nowhere to get updates from. This normally means it has ' +
      'not been sent yet. Nothing is wrong with your work.',
    fix: {
      id: 'link-to-server',
      label: 'Link it up and get updates',
      note:
        'Finds the matching branch on the server and connects them. If there ' +
        'is none, it says so and changes nothing.'
    }
  },
  {
    // Git wraps this across two lines, so the pattern must not assume the
    // words stay together: "...does not match\nthe name of your current
    // branch."
    match: /upstream branch of your current branch does not match|does not match\s+the name of your current branch/i,
    title: 'This workstream is pointing at the wrong place on the server',
    detail:
      'It is set to send to a different branch than the one you are working ' +
      'on - usually the shared version it was started from. Sending has been ' +
      'stopped rather than risk putting your work somewhere nobody expects ' +
      'it. Nothing has been sent and nothing is lost.',
    fix: {
      id: 'realign-upstream',
      label: 'Give it its own place on the server',
      note:
        'Sends this workstream under its own name and points it there from ' +
        'now on. The shared version is not touched.'
    }
  },
  {
    match: /src refspec .* does not match any|error: src refspec/i,
    title: 'That workstream does not exist yet',
    detail:
      'There is nothing on this computer under that name to send. It may ' +
      'have been renamed or removed since the panel last looked - try ' +
      'Refresh.',
    fix: null
  },
  {
    // The other side of a stale remote-tracking ref: the panel offered a
    // workstream that was deleted on the server, because a plain fetch
    // never removes the local record of one. The branch is not missing -
    // the list was out of date.
    match: /couldn't find remote ref|unable to find remote ref|remote ref does not exist/i,
    title: 'That workstream is no longer on the team server',
    detail:
      'Somebody removed it there - normally because it was finished and ' +
      'combined into the shared version. Your own copy and everything saved ' +
      'in it are untouched on this computer.',
    fix: {
      id: 'refresh-server-list',
      label: 'Update the list from the server',
      note:
        'Refreshes what this computer thinks the server has, so removed ' +
        'workstreams stop being offered. Nothing of yours is changed.'
    }
  },
  {
    match: /failed to push some refs|non-fast-forward|fetch first/i,
    title: 'The team has newer changes',
    detail:
      'Someone else sent work to the server after you last downloaded. Get ' +
      'their updates first, then send yours.',
    fix: {
      id: 'merge-divergent',
      label: 'Get their updates now',
      note: 'Downloads and combines their work with yours.'
    }
  },
  {
    // Reached only when something bypasses planDeleteWorkstream(), which
    // classifies this case properly. Worth translating anyway: git's own
    // wording sends people straight to `-D`, which is the one option that
    // can actually lose the work.
    match: /branch '.*' is not fully merged|not fully merged/i,
    title: 'That workstream still has work of its own',
    detail:
      'It has save points that are not in the shared version and are not on ' +
      'the team server, so removing it would be the only copy gone. Finish ' +
      'it, or send it to the team first. Nothing has been removed.',
    fix: null
  },
  {
    match: /could not resolve host|unable to access|connection timed out|network is unreachable/i,
    title: 'Cannot reach the team server',
    detail:
      'This looks like a network problem rather than anything wrong with ' +
      'your work. Check your connection or VPN and try again. Nothing you ' +
      'have done has been lost.',
    fix: null
  },
  {
    match: /authentication failed|permission denied|could not read username|invalid credentials/i,
    title: 'The server did not accept your sign-in',
    detail:
      'Your access to the project server needs to be set up or renewed. ' +
      'This is not something the plugin can fix - ask whoever manages the ' +
      'repository. Your work is safe on this computer.',
    fix: null
  },
  {
    match: /index\.lock|another git process/i,
    title: 'Another operation is still running',
    detail:
      'Something else is using the project folder right now. Wait a moment ' +
      'and try again. If it keeps happening, close other git tools.',
    fix: null
  },
  {
    match: /not a git repository/i,
    title: 'This folder is not set up for the team yet',
    detail:
      'The selected folder is not a project the plugin can track. Use ' +
      '"Git: Repository Settings..." to pick the right one.',
    fix: null
  },
  {
    match: /you are not currently on a branch|detached HEAD|looking at an old version/i,
    title: 'You are looking at an old version',
    detail:
      'You are viewing a past state of the project rather than working on a ' +
      'workstream. Anything saved here belongs to no workstream and is hard ' +
      'to find again afterwards. Nothing is lost yet.',
    fix: {
      id: 'return-to-workstream',
      label: 'Put me back on a workstream',
      note:
        'Saves anything unsaved first, and gives it its own workstream if ' +
        'it is not already on one. Nothing is discarded.'
    }
  }
];

/**
 * Translate an error into the shape the panel renders.
 *
 * Unrecognised errors pass through with their original text rather than
 * being hidden behind a vague message - an unfamiliar error the user can
 * paste to someone beats a friendly one that says nothing.
 */
/**
 * Does this look like raw output from git rather than a message this
 * plugin wrote?
 *
 * Errors thrown deliberately by the plugin ("A workstream called X already
 * exists.") are already in the reader's language, so wrapping them in
 * "Something went wrong" and hiding them in a detail line makes them
 * strictly worse. Git's own output is reliably prefixed or multi-line.
 */
function looksLikeGitOutput(text) {
  return /^(fatal|error|warning|hint|remote|usage)\s*:/im.test(text) ||
    /\n/.test(text.trim()) ||
    /\bgit\b\s+[a-z-]+/.test(text);
}

function translate(err) {
  const raw = (err && (err.message || err.toString())) || String(err);

  const hit = PATTERNS.find(p => p.match.test(raw));

  if (!hit) {
    // Our own message: show it as-is rather than burying it.
    if (!looksLikeGitOutput(raw)) {
      return {
        title: raw,
        detail: null,
        fix: null,
        raw,
        recognised: true
      };
    }

    return {
      title: 'Something went wrong',
      detail: raw,
      fix: null,
      raw,
      recognised: false
    };
  }

  return {
    title: hit.title,
    detail: hit.detail,
    fix: hit.fix,
    raw,
    recognised: true
  };
}

module.exports = { translate, PATTERNS };
