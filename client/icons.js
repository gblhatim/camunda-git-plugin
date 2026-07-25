/**
 * Icons.
 *
 * Modeler exposes the IBM Carbon icon set to plugins on
 * `window.vendor.carbonIconsReact`, which is worth using: the icons match
 * the ones Modeler draws itself, and they cost nothing in the bundle.
 *
 * It is reached defensively though - it is not part of the documented
 * plugin API, so a Modeler version that stops exposing it must degrade to
 * plain glyphs rather than crash the panel.
 */

import React from 'camunda-modeler-plugin-helpers/vendor/react.js';

const h = React.createElement;

function carbonSet() {
  try {
    return (window.vendor && window.vendor.carbonIconsReact) || null;
  } catch (err) {
    return null;
  }
}

const CARBON = carbonSet();

/**
 * Text stand-ins, used when Carbon is unavailable. Deliberately plain
 * characters rather than emoji, which render inconsistently and look out
 * of place next to Modeler's own UI.
 */
const FALLBACK = {
  Folder: '▸',
  FolderOpen: '▾',
  Document: '·',
  Branch: '⑂',
  Commit: '●',
  Merge: '⑃',
  Tag: '#',
  Add: '+',
  Subtract: '−',
  Renew: '↻',
  Settings: '⚙',
  Terminal: '>',
  Warning: '!',
  CheckmarkFilled: '✓',
  CloseFilled: '✕',
  ArrowUp: '↑',
  ArrowDown: '↓'
};

/**
 * Render a Carbon icon by name, falling back to a glyph.
 *
 * @param {string} name  Carbon component name, e.g. "FolderOpen"
 * @param {object} props size (px), className, title
 */
export function Icon({ name, size = 16, className, title }) {
  const Component = CARBON && CARBON[name];

  if (Component) {
    return h(Component, {
      size,
      className: `cgp-icon ${className || ''}`.trim(),
      'aria-label': title || undefined
    });
  }

  return h('span', {
    className: `cgp-icon cgp-icon--text ${className || ''}`.trim(),
    title,
    style: { fontSize: `${Math.round(size * 0.85)}px`, lineHeight: 1 }
  }, FALLBACK[name] || '·');
}

/** Whether the real icon set is available - used by tests and diagnostics. */
export const hasCarbon = !!CARBON;
