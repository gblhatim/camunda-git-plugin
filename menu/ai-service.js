/**
 * AI edits of a diagram, via OpenRouter.
 *
 * The whole design is preview-then-apply, because an LLM editing BPMN XML by
 * hand is exactly the kind of thing that produces plausible, invalid output:
 * a dropped `bpmndi:` shape, a dangling reference, a renamed id. So nothing
 * the model returns is trusted. It is parsed before it is ever offered
 * (unparseable output is rejected, not written), it is diffed against the
 * original so the change is *visible*, and it is only written to disk when
 * the user accepts - staged like any other change, never committed.
 *
 * Two things leave this machine, and only on an explicit preview: the
 * diagram's XML and the instruction. The API key sits in the same plaintext
 * config as the git tokens - presence is all the renderer ever sees.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const configStore = require('./config-store');
const gitService = require('./git-service');
const diagramDiffService = require('./diagram-diff-service');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

const SYSTEM_PROMPT = [
  'You are an expert editor of Camunda BPMN 2.0 XML.',
  'You are given a complete BPMN 2.0 XML document and an instruction describing one change to make.',
  'Return the COMPLETE modified BPMN 2.0 XML document and nothing else - no explanation, no markdown code fences.',
  'Rules:',
  '- Keep the XML declaration and every namespace exactly as given.',
  '- Keep every existing element id unchanged, unless the instruction requires removing that element.',
  '- Preserve the diagram interchange (bpmndi:/dc:/di:) layout for every element you keep, and add reasonable coordinates for any element you add so it renders on the canvas.',
  '- Make only the change described; leave everything else exactly as it was.',
  '- The result must be valid BPMN 2.0 that Camunda Modeler can open.'
].join('\n');

// The latest proposal per file, so applying does not re-call the model (cost,
// and a second call would not return the same thing the user just approved).
const proposals = new Map();

function apiKey() {
  const key = configStore.readConfig().openRouterKey;

  if (!key) {
    throw new Error(
      'No OpenRouter API key yet. Add one under Git Settings to use AI edits.'
    );
  }

  return key;
}

function model() {
  return configStore.readConfig().openRouterModel || DEFAULT_MODEL;
}

/**
 * Pull the XML out of a model response that may have wrapped it in a fence or
 * added a line of chat despite being told not to.
 */
function extractXml(content) {
  let text = String(content || '').trim();

  const fenced = text.match(/```(?:xml)?\s*([\s\S]*?)```/i);
  if (fenced) {
    text = fenced[1].trim();
  }

  // Drop anything before the document actually starts.
  const start = text.search(/<\?xml|<(?:\w+:)?definitions[\s>]/i);
  if (start > 0) {
    text = text.slice(start);
  }

  return text.trim();
}

async function callOpenRouter(instruction, xml) {
  // node-fetch is already a dependency (remote-service uses it).
  const fetch = require('node-fetch');

  let res;

  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://camunda.org',
        'X-Title': 'Camunda Git Plugin'
      },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${instruction}\n\nHere is the current diagram:\n\n${xml}` }
        ]
      })
    });
  } catch (err) {
    throw new Error(`Could not reach OpenRouter: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    if (res.status === 401) throw new Error('OpenRouter rejected the API key. Check it in Git Settings.');
    if (res.status === 402) throw new Error('OpenRouter reports no credit on this key.');
    if (res.status === 429) throw new Error('OpenRouter is rate-limiting; wait a moment and try again.');

    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;

  if (!content) {
    throw new Error('OpenRouter returned an empty response.');
  }

  return content;
}

function absFor(rel) {
  gitService.assertSafeRelativePath(rel);
  return path.join(gitService.getRepoPath(), rel);
}

/**
 * Ask the model for an edit and return the change for review. Writes
 * nothing; the proposal is held until `apply` or the next preview.
 */
async function editPreview({ path: rel, instruction }) {
  if (!rel) {
    throw new Error('Choose a diagram to edit.');
  }

  if (!/\.bpmn$/i.test(rel)) {
    throw new Error('AI edits work on BPMN diagrams (.bpmn).');
  }

  const text = String(instruction || '').trim();
  if (!text) {
    throw new Error('Describe the change you want.');
  }

  const abs = absFor(rel);

  let before;
  try {
    before = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${rel}: ${err.message}`);
  }

  // Reject a starting file that is not valid BPMN, rather than asking the
  // model to edit something that will not diff.
  try {
    await diagramDiffService.parse(before);
  } catch (err) {
    throw new Error(`${rel} is not valid BPMN, so it cannot be edited: ${err.message}`);
  }

  const raw = await callOpenRouter(text, before);
  const after = extractXml(raw);

  // The core safety gate: unparseable output never becomes a proposal.
  try {
    await diagramDiffService.parse(after);
  } catch (err) {
    throw new Error(
      'The AI returned something that is not valid BPMN, so nothing was changed. ' +
      'Try rewording the instruction.'
    );
  }

  let diff;
  try {
    diff = await diagramDiffService.compare(before, after);
  } catch (err) {
    diff = { comparable: false, reason: err.message };
  }

  const hasChanges = !!(diff.comparable && diff.summary &&
    (diff.summary.added || diff.summary.removed || diff.summary.changed || diff.summary.moved));

  proposals.set(rel, { before, after, diff, name: path.basename(rel), model: model() });

  return {
    ok: true,
    path: rel,
    name: path.basename(rel),
    model: model(),
    instruction: text,
    hasChanges,
    diff
  };
}

/**
 * The held proposal for a file, for the before/after review window.
 */
function getProposal(rel) {
  return proposals.get(rel) || null;
}

/**
 * Write the approved proposal to disk and stage it. Never commits - it shows
 * up as an ordinary change in Source Control to save when the user is ready.
 */
async function editApply({ path: rel }) {
  const proposal = proposals.get(rel);

  if (!proposal) {
    throw new Error('Preview an edit first - there is nothing approved to apply.');
  }

  const abs = absFor(rel);

  fs.writeFileSync(abs, proposal.after, 'utf8');
  await gitService.getGit().add([ rel ]);

  proposals.delete(rel);

  return { applied: true, path: rel, name: proposal.name };
}

function discard(rel) {
  proposals.delete(rel);
  return { discarded: true, path: rel };
}

module.exports = {
  editPreview,
  editApply,
  getProposal,
  discard,
  extractXml
};
