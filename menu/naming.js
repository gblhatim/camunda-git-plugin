/**
 * Branch names: how they are built, and how they are read back.
 *
 * A name like `feature/BDM-123456-invoice-approval-redesign` carries three
 * things - what kind of work it is, which ticket it belongs to, and what it
 * is about. All three are recovered by parsing rather than stored anywhere,
 * for the same reason display names always were: a mapping file that has to
 * stay in step with real branches is more failure modes than it is worth.
 *
 * The ticket is deliberately kept *visible* in the display name. It is the
 * one part a developer will paste into Jira, a build log or a standup, and
 * a "friendly" name that hides it just means looking the branch up again.
 * So `feature/BDM-123456-invoice-approval` reads as
 * "BDM-123456 · Invoice approval" rather than "Invoice approval".
 */

'use strict';

const DEFAULT_PROJECT_KEY = 'BDM';

/**
 * The three kinds of work, and the rules that differ between them.
 *
 * `startsFrom` is the Gitflow shape: features and fixes grow from the
 * integration branch, hotfixes from what is actually released. Under a
 * trunk model both resolve to the same branch and the distinction costs
 * nothing.
 *
 * Hotfixes are the one case where a ticket is optional. Requiring someone
 * to raise a ticket before they can start fixing a live outage is a rule
 * that gets broken rather than followed, and a hotfix branch is short-lived
 * and highly visible anyway.
 */
const TYPES = {
  feature: {
    id: 'feature',
    prefix: 'feature/',
    label: 'New work',
    hint: 'A change to how a process runs',
    ticketRequired: true,
    startsFrom: 'base'
  },
  bugfix: {
    id: 'bugfix',
    prefix: 'bugfix/',
    label: 'Fix',
    hint: 'Something is wrong and needs correcting',
    ticketRequired: true,
    startsFrom: 'base'
  },
  hotfix: {
    id: 'hotfix',
    prefix: 'hotfix/',
    label: 'Urgent fix',
    hint: 'Something is broken in what is live right now',
    ticketRequired: false,
    startsFrom: 'release'
  }
};

const TYPE_IDS = Object.keys(TYPES);

// Longest prefix first would matter if one were a prefix of another; they
// are not, but sorting keeps that true if a fourth is ever added.
const PREFIXES = TYPE_IDS
  .map(id => TYPES[id])
  .sort((a, b) => b.prefix.length - a.prefix.length);

function projectKey(config) {
  const key = (config && config.jiraProjectKey) || DEFAULT_PROJECT_KEY;

  return String(key).toUpperCase();
}

/**
 * `BDM-123456`, and only that project's tickets.
 *
 * Restricting to one key is the whole point: `ABC-1` matching would let a
 * typo in the project key through, and a branch named after a ticket that
 * does not exist is worse than one with no ticket at all.
 */
function ticketPattern(config) {
  return new RegExp(`^${projectKey(config)}-(\\d+)$`, 'i');
}

/**
 * Check and normalise a ticket reference. Returns the canonical uppercase
 * form, or null when there is nothing to check.
 */
function normalizeTicket(raw, config) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }

  const trimmed = String(raw).trim();
  const key = projectKey(config);

  // People paste the whole URL as often as the id.
  const fromUrl = trimmed.match(/\/browse\/([A-Za-z]+-\d+)/);
  const candidate = fromUrl ? fromUrl[1] : trimmed;

  // A bare number is unambiguous once the project key is fixed, and it is
  // what someone reading the id aloud off a board will type.
  if (/^\d+$/.test(candidate)) {
    return `${key}-${candidate}`;
  }

  if (!ticketPattern(config).test(candidate)) {
    throw new Error(
      `"${trimmed}" is not a ${key} ticket. Enter it as ${key}-123456, or ` +
      'just the number.'
    );
  }

  return candidate.toUpperCase();
}

/**
 * "Invoice approval redesign" -> "invoice-approval-redesign"
 */
function slugify(displayName) {
  const slug = String(displayName === undefined || displayName === null ? '' : displayName)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');               // slice may have left a trailing dash

  if (!slug) {
    throw new Error('Please give this workstream a name.');
  }

  return slug;
}

/**
 * Take a branch name apart. Every field is optional except `slug`, because
 * this has to cope with every branch that already exists in a repository
 * that predates any of these rules.
 */
function parse(branchName, config) {
  const name = String(branchName || '');
  const type = PREFIXES.find(t => name.startsWith(t.prefix));
  const rest = type ? name.slice(type.prefix.length) : name;

  const pattern = new RegExp(`^(${projectKey(config)}-\\d+)[-_/]?(.*)$`, 'i');
  const matched = rest.match(pattern);

  const ticket = matched ? matched[1].toUpperCase() : null;
  const slug = matched ? matched[2] : rest;

  return {
    type: type ? type.id : null,
    ticket,
    slug,
    branch: name
  };
}

/**
 * The name shown to a human. Keeps the ticket, drops the machinery.
 *
 * `feature/BDM-123456-invoice-approval` -> "BDM-123456 · Invoice approval"
 */
function humanize(branchName, config) {
  const { ticket, slug } = parse(branchName, config);

  const words = String(slug).replace(/[-_]+/g, ' ').trim();
  const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : '';

  if (ticket && title) {
    return `${ticket} · ${title}`;
  }

  // A branch that is only a ticket is still perfectly identifiable.
  return ticket || title || String(branchName || '');
}

/**
 * Build a branch name from what the user chose, enforcing the ticket rule
 * for the type they picked.
 */
function buildBranchName({ type, ticket, title }, config) {
  const definition = TYPES[type];

  if (!definition) {
    throw new Error(`"${type}" is not a kind of work. Choose one of: ${TYPE_IDS.join(', ')}.`);
  }

  const normalized = normalizeTicket(ticket, config);

  if (definition.ticketRequired && !normalized) {
    throw new Error(
      `A ${projectKey(config)} ticket is required for ${definition.label.toLowerCase()}. ` +
      'Enter it as ' + projectKey(config) + '-123456, or just the number.'
    );
  }

  const slug = slugify(title);

  return {
    name: `${definition.prefix}${normalized ? `${normalized}-` : ''}${slug}`,
    type: definition.id,
    ticket: normalized,
    slug,
    startsFrom: definition.startsFrom
  };
}

/**
 * Where the ticket goes in a commit message.
 *
 * Prefixed rather than appended so `git log --oneline` stays scannable by
 * ticket, and skipped when the author already typed it - people who know
 * the convention should not end up with it twice.
 */
function applyTicketToMessage(message, ticket) {
  const text = String(message || '').trim();

  if (!ticket || !text) {
    return text;
  }

  if (new RegExp(`\\b${ticket}\\b`, 'i').test(text)) {
    return text;
  }

  return `${ticket} ${text}`;
}

/**
 * Where this ticket lives, for a link out of the panel. Null when no Jira
 * host has been configured - a dead link is worse than none.
 */
function ticketUrl(ticket, config) {
  const host = config && config.jiraHost;

  if (!ticket || !host) {
    return null;
  }

  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;

  return `${base.replace(/\/+$/, '')}/browse/${ticket}`;
}

module.exports = {
  TYPES,
  TYPE_IDS,
  DEFAULT_PROJECT_KEY,
  projectKey,
  ticketPattern,
  normalizeTicket,
  slugify,
  parse,
  humanize,
  buildBranchName,
  applyTicketToMessage,
  ticketUrl
};
