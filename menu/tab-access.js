/**
 * Which areas of the panel this project shows.
 *
 * A team running the plugin for analysts does not want six areas: Releases
 * and the git console are not theirs to operate, and an area that exists
 * only to be avoided is worse than no area. So the set is part of the
 * *project's* settings, committed in `.camunda-git.json` alongside the
 * branch model - one decision for everyone who clones the repo, not a
 * per-machine guess that drifts.
 *
 * This is a guardrail, not a permission system. The file is plain JSON in
 * the working tree, and anyone who can open the project can edit it. It
 * keeps people out of areas they have no business in by accident; it stops
 * nobody who means to get there. The UI says so rather than implying a lock
 * that does not exist.
 *
 * Editing the set is gated on `developerMode` (see settings-service), which
 * is per-machine and already the flag that separates "operates this repo"
 * from "administers it".
 */

'use strict';

/**
 * Every area that can be gated, in panel order. `id` matches the Fill id in
 * client/index.js - the renderer is bundled separately and cannot require
 * this module, so the two lists are duplicated on purpose and this one is
 * the authority. An id here that the client does not register is inert; an
 * id the client registers that is missing here can never be turned off.
 */
const TABS = [
  { id: 'git-my-work',  label: 'My Work',  description: 'Now, Changes and History - the daily loop.' },
  { id: 'git-team',     label: 'Team',     description: 'Overview, Requests and Releases.' },
  { id: 'git-diagrams', label: 'Diagrams', description: 'Files, Search and the pattern catalog.' },
  { id: 'git-ai',       label: 'AI',       description: 'Chat and AI-assisted edits.' },
  { id: 'git-activity', label: 'Activity', description: 'What the plugin ran, and the git console.' },
  { id: 'git-settings', label: 'Settings', description: 'Always on - it is how the rest get turned back on.' }
];

const ALL_IDS = TABS.map(t => t.id);

/**
 * Settings can never be turned off. It is the only way back: a project that
 * disabled it would have no route to re-enable anything short of editing
 * the JSON by hand, which is exactly the dead end this should not create.
 */
const ALWAYS_ON = [ 'git-settings' ];

/**
 * The stored value into a set that is safe to act on.
 *
 * Absent means "everything", which is what every project that predates this
 * gets - a missing key must never blank someone's panel. An empty array is
 * a real choice (show only what is pinned on), so it is distinguished from
 * absent rather than being treated as falsy.
 */
function normalize(value) {
  if (!Array.isArray(value)) {
    return ALL_IDS.slice();
  }

  const wanted = new Set(
    value.filter(id => typeof id === 'string' && ALL_IDS.includes(id))
  );

  ALWAYS_ON.forEach(id => wanted.add(id));

  // Panel order, not the order they happened to be written in.
  return ALL_IDS.filter(id => wanted.has(id));
}

function isEnabled(value, id) {
  return normalize(value).includes(id);
}

module.exports = {
  TABS,
  ALL_IDS,
  ALWAYS_ON,
  normalize,
  isEnabled
};
