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
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

const SYSTEM_PROMPT = [
  'You are an expert editor of Camunda BPMN 2.0 XML.',
  'You are given a complete BPMN 2.0 XML document and an instruction describing one change to make.',
  'Return the COMPLETE modified BPMN 2.0 XML document and nothing else - no explanation, no markdown code fences.',
  'Rules:',
  '- Keep the XML declaration and every namespace exactly as given.',
  '- Keep every existing element id unchanged, unless the instruction requires removing that element.',
  '- Preserve the diagram interchange (bpmndi:/dc:/di:) layout for every element you keep, and add reasonable coordinates for any element you add so it renders on the canvas.',
  '- Make only the change described; leave everything else exactly as it was.',
  '- Every sequence flow must have both a sourceRef and a targetRef, each pointing at an element that exists; never leave a flow dangling.',
  '- Give every new element a BPMNShape (or BPMNEdge for a flow) in the diagram, or it will not appear.',
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
    if (res.status === 404) {
      throw new Error(
        `The model "${model()}" is not available on OpenRouter. Pick another ` +
        'from the Model list in the AI Edit tab (or Git Settings).'
      );
    }

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
 * A document can parse and still be un-openable. bpmn-moddle accepts a flow
 * with a missing end without complaint, but bpmn-js refuses to import it
 * ("targetRef not specified") - so Modeler shows an error, not a diagram.
 * A parse that succeeds is not proof of an openable file; this catches the
 * gap the model most often falls into.
 */
function assertOpenable(root) {
  const byId = diagramDiffService.indexElements(root);

  for (const el of byId.values()) {
    if (/:(SequenceFlow|MessageFlow)$/.test(String(el.$type || ''))) {
      if (!el.sourceRef) throw new Error(`flow ${el.id} has no source`);
      if (!el.targetRef) throw new Error(`flow ${el.id} has no target`);
    }
  }
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

  // The core safety gate: output that will not parse *or* will not open in
  // Modeler never becomes a proposal.
  try {
    const afterRoot = await diagramDiffService.parse(after);
    assertOpenable(afterRoot);
  } catch (err) {
    throw new Error(
      `The AI produced a diagram that would not open in Modeler (${err.message}), ` +
      'so nothing was changed. Try rewording the instruction.'
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
 * The models this key can actually use, so the UI can offer real ids rather
 * than a guessed default that 404s. Anthropic first (the plugin's default
 * house), then the rest alphabetically.
 */
async function listModels() {
  const fetch = require('node-fetch');

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey()}` }
    });
  } catch (err) {
    throw new Error(`Could not reach OpenRouter: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Could not load the model list (OpenRouter ${res.status}).`);
  }

  const data = await res.json();

  const models = (data.data || [])
    .map(m => ({ id: m.id, name: m.name || m.id }))
    .filter(m => m.id)
    .sort((a, b) => {
      const aAnthropic = a.id.startsWith('anthropic/');
      const bAnthropic = b.id.startsWith('anthropic/');
      if (aAnthropic !== bAnthropic) return aAnthropic ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  return { models, current: model() };
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
  listModels,
  discard,
  extractXml,
  assertOpenable
};
