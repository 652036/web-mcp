import {
  deepClone,
  effectiveCell,
  exportMarkdown,
  exportMarkdownPage,
  findEvidenceGaps,
  findEvidenceGapsPage,
  getScenario,
  makeId,
  normalizeWorkspace,
  normalizedWeights,
  rankOptions,
  readWorkspacePage,
  runStressTest,
  summarizeWorkspace,
  WORKSPACE_LIMITS,
  WORKSPACE_READ_SECTIONS,
} from './engine.js';
import { createBlankWorkspace, examples, getExample } from './data.js';
import { commitWorkspaceSnapshot, restoreWorkspace } from './storage.js';
import { installWebMCP, schemas, uninstallWebMCP } from './webmcp.js';

const STORAGE_KEY = 'forkcast.workspace.v1';
const THEME_KEY = 'forkcast.theme';
const MAX_HISTORY = 40;

const byId = (id) => document.getElementById(id);
const restored = restoreWorkspace(localStorage, STORAGE_KEY, {
  fallback: getExample('launch'),
  normalize: normalizeWorkspace,
});
if (restored.warning) console.warn(restored.warning.message, restored.warning.cause);
const stateful = {
  workspace: restored.workspace,
  undoStack: [],
  webmcp: null,
};

function text(value) {
  return document.createTextNode(String(value ?? ''));
}

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key === 'textContent') element.textContent = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'disabled') element.disabled = Boolean(value);
    else if (key === 'value') element.value = value;
    else if (key.startsWith('aria')) element.setAttribute(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), String(value));
    else element.setAttribute(key, String(value));
  }
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : text(child));
  }
  return element;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function optionById(id) {
  return stateful.workspace.options.find((option) => option.id === id);
}

function criterionById(id) {
  return stateful.workspace.criteria.find((criterion) => criterion.id === id);
}

function requireOption(id) {
  const option = optionById(id);
  if (!option) throw new Error(`Unknown option id: ${id}`);
  return option;
}

function requireCriterion(id) {
  const criterion = criterionById(id);
  if (!criterion) throw new Error(`Unknown criterion id: ${id}`);
  return criterion;
}

function ensureMutable() {
  if (stateful.workspace.committedDecision) {
    throw new Error('This decision is committed. Create or load a new workspace before changing it.');
  }
}

function recordActivity(workspace, actor, message) {
  workspace.activity ??= [];
  const activity = {
    id: makeId('activity'),
    at: new Date().toISOString(),
    actor,
    text: message,
  };
  workspace.activity.unshift(activity);
  workspace.activity = workspace.activity.slice(0, 60);
  return activity;
}

function nextHistory(previous, { actor, message }) {
  return [...stateful.undoStack, { workspace: previous, actor, message }].slice(-MAX_HISTORY);
}

function commitState(workspace, history) {
  const committed = commitWorkspaceSnapshot({
    storage: localStorage,
    key: STORAGE_KEY,
    workspace,
    history,
  });
  stateful.workspace = committed.workspace;
  stateful.undoStack = committed.history;
}

function ensureCapacity(collection, maximum, label) {
  if (collection.length >= maximum) {
    throw new RangeError(`${label} limit reached (${maximum}). Remove or reuse an existing item before adding another.`);
  }
}

function mutate(message, updater, { actor = 'agent', allowCommitted = false } = {}) {
  if (!allowCommitted) ensureMutable();
  const previous = deepClone(stateful.workspace);
  const next = deepClone(stateful.workspace);
  updater(next);
  recordActivity(next, actor, message);
  const normalized = normalizeWorkspace(next, previous);
  commitState(normalized, nextHistory(previous, { actor, message }));
  render();
  refreshTools();
  return summarizeWorkspace(stateful.workspace);
}

function replaceWorkspace(workspace, message) {
  const previous = deepClone(stateful.workspace);
  const next = normalizeWorkspace(workspace, createBlankWorkspace());
  recordActivity(next, 'human', message);
  commitState(next, nextHistory(previous, { actor: 'human', message }));
  render();
  refreshTools();
}

function undoLast(actor = 'human') {
  const entry = stateful.undoStack.at(-1);
  if (!entry) throw new Error('There is no change to undo.');
  if (actor === 'agent' && entry.actor !== 'agent') {
    throw new Error('The latest change belongs to the human and cannot be undone by an agent.');
  }
  const next = normalizeWorkspace(deepClone(entry.workspace), createBlankWorkspace());
  recordActivity(next, actor, `Undid: ${entry.message}`);
  commitState(next, stateful.undoStack.slice(0, -1));
  render();
  refreshTools();
  return summarizeWorkspace(stateful.workspace);
}

function toast(message, tone = 'default') {
  const region = byId('toast-region');
  const item = node('div', { className: `toast toast--${tone}`, role: 'status' }, message);
  region.append(item);
  setTimeout(() => item.remove(), 4200);
}

function setFieldValue(id, value) {
  const element = byId(id);
  if (element && document.activeElement !== element) element.value = value ?? '';
}

function renderHeader() {
  const workspace = stateful.workspace;
  byId('workspace-title').textContent = workspace.brief.title || 'Untitled decision';
  const status = workspace.committedDecision
    ? 'Committed'
    : workspace.stagedRecommendation
      ? 'Awaiting human review'
      : 'In progress';
  byId('workspace-status').textContent = status;
  byId('workspace-status').dataset.state = workspace.committedDecision ? 'committed' : workspace.stagedRecommendation ? 'review' : 'active';
  byId('undo-button').disabled = stateful.undoStack.length === 0;
  document.querySelectorAll('[data-requires-mutable]').forEach((control) => {
    control.disabled = Boolean(workspace.committedDecision);
  });

  const latest = workspace.activity?.[0];
  if (latest) {
    byId('shared-action-actor').textContent = latest.actor === 'agent'
      ? 'Agent'
      : latest.actor === 'human'
        ? 'You'
        : 'Workspace';
    byId('shared-action-text').textContent = latest.text;
    byId('shared-action-time').textContent = formatDate(latest.at);
    byId('shared-action-time').dateTime = latest.at;
  } else {
    byId('shared-action-actor').textContent = 'Workspace';
    byId('shared-action-text').textContent = 'No shared actions yet.';
    byId('shared-action-time').textContent = '';
    byId('shared-action-time').removeAttribute('datetime');
  }
}

function renderBrief() {
  const { brief, options } = stateful.workspace;
  byId('decision-question').textContent = brief.question || 'Define the question this workspace should answer.';
  byId('decision-context').textContent = brief.context || 'No context recorded yet.';
  byId('decision-constraints').textContent = brief.constraints || 'No constraints recorded yet.';
  byId('option-count').textContent = String(options.length);
  byId('criterion-count').textContent = String(stateful.workspace.criteria.length);
  byId('gap-count').textContent = String(findEvidenceGaps(stateful.workspace).length);

  const list = byId('option-list');
  list.replaceChildren();
  options.forEach((option, index) => {
    list.append(node('article', { className: 'option-chip' }, [
      node('span', { className: 'option-chip__index' }, String(index + 1).padStart(2, '0')),
      node('div', { className: 'option-chip__copy' }, [
        node('strong', {}, option.name),
        node('span', {}, option.description || 'No description'),
      ]),
      node('button', {
        className: 'icon-button', type: 'button', title: `Edit ${option.name}`,
        dataset: { action: 'edit-option', optionId: option.id },
        ariaLabel: `Edit ${option.name}`,
        disabled: Boolean(stateful.workspace.committedDecision),
      }, 'Edit'),
    ]));
  });
}

function renderRanking() {
  const ranking = rankOptions(stateful.workspace);
  const container = byId('ranking-list');
  container.replaceChildren();
  if (!ranking.length) {
    container.append(node('p', { className: 'empty-state' }, 'Add options and criteria to calculate a ranking.'));
    return;
  }
  const max = Math.max(...ranking.map((item) => item.score), 1);
  ranking.forEach((item, index) => {
    const uncertainty = Math.max(0, 100 - item.confidence);
    container.append(node('article', { className: `ranking-row${index === 0 ? ' ranking-row--leader' : ''}` }, [
      node('div', { className: 'ranking-row__rank' }, String(index + 1).padStart(2, '0')),
      node('div', { className: 'ranking-row__body' }, [
        node('div', { className: 'ranking-row__headline' }, [
          node('strong', {}, item.option),
          node('span', { className: 'score-number' }, item.score.toFixed(2)),
        ]),
        node('div', { className: 'score-track', role: 'img', ariaLabel: `${item.option} score ${item.score.toFixed(2)} out of 10` },
          node('span', { style: `width:${Math.min(100, (item.score / max) * 100)}%` })),
        node('div', { className: 'ranking-row__meta' }, [
          node('span', {}, `${item.confidence.toFixed(0)}% confidence`),
          node('span', {}, `${uncertainty.toFixed(0)}% unresolved`),
        ]),
      ]),
    ]));
  });
}

function renderCriteria() {
  const container = byId('criteria-list');
  container.replaceChildren();
  const scenario = getScenario(stateful.workspace);
  const weights = normalizedWeights(stateful.workspace);

  stateful.workspace.criteria.forEach((criterion) => {
    const rawWeight = scenario?.weightOverrides?.[criterion.id] ?? criterion.weight;
    const label = node('label', { className: 'criterion-row' }, [
      node('div', { className: 'criterion-row__copy' }, [
        node('strong', {}, criterion.name),
        node('span', {}, criterion.description || 'No description'),
      ]),
      node('div', { className: 'criterion-row__control' }, [
        node('input', {
          type: 'range', min: '0', max: '100', step: '1', value: String(rawWeight),
          dataset: { action: 'criterion-weight', criterionId: criterion.id },
          ariaLabel: `${criterion.name} raw weight`,
          disabled: Boolean(stateful.workspace.committedDecision),
        }),
        node('output', {}, `${Math.round((weights[criterion.id] ?? 0) * 100)}%`),
      ]),
    ]);
    container.append(label);
  });
  byId('scenario-weight-note').textContent = scenario
    ? `Weights shown for “${scenario.name}”. Base values remain unchanged.`
    : 'Weights are normalized automatically to 100%.';
}

function renderMatrix() {
  const table = byId('evidence-matrix');
  table.replaceChildren();
  const { options, criteria } = stateful.workspace;
  if (!options.length || !criteria.length) {
    table.append(node('caption', {}, 'Add options and criteria to build the evidence matrix.'));
    return;
  }

  const headRow = node('tr', {}, [node('th', { scope: 'col' }, 'Criterion')]);
  options.forEach((option) => headRow.append(node('th', { scope: 'col' }, option.name)));
  table.append(node('thead', {}, headRow));
  const body = node('tbody');

  criteria.forEach((criterion) => {
    const row = node('tr', {}, [
      node('th', { scope: 'row' }, [
        node('strong', {}, criterion.name),
        node('span', {}, `${Math.round((normalizedWeights(stateful.workspace)[criterion.id] ?? 0) * 100)}%`),
      ]),
    ]);
    options.forEach((option) => {
      const cell = effectiveCell(stateful.workspace, option.id, criterion.id);
      const hasGap = !cell.evidence || cell.confidence < 55;
      row.append(node('td', {}, node('button', {
        className: `matrix-cell${hasGap ? ' matrix-cell--gap' : ''}`,
        type: 'button',
        dataset: { action: 'edit-score', optionId: option.id, criterionId: criterion.id },
        ariaLabel: `Edit ${option.name}, ${criterion.name}: score ${cell.score}, confidence ${cell.confidence}%`,
        disabled: Boolean(stateful.workspace.committedDecision),
      }, [
        node('strong', {}, cell.score.toFixed(1)),
        node('span', {}, `${cell.confidence.toFixed(0)}% conf.`),
        node('small', {}, cell.evidence ? 'Evidence recorded' : 'Evidence needed'),
      ])));
    });
    body.append(row);
  });
  table.append(body);
}

function renderAssumptions() {
  const container = byId('assumption-list');
  container.replaceChildren();
  const assumptions = stateful.workspace.assumptions;
  if (!assumptions.length) {
    container.append(node('p', { className: 'empty-state' }, 'No assumptions recorded. Add the unknowns that could change the decision.'));
    return;
  }
  assumptions.forEach((assumption) => {
    const select = node('select', {
      dataset: { action: 'assumption-status', assumptionId: assumption.id },
      ariaLabel: `Status for assumption: ${assumption.text}`,
      disabled: Boolean(stateful.workspace.committedDecision),
    });
    ['open', 'testing', 'validated', 'invalidated'].forEach((status) => {
      select.append(node('option', { value: status }, status));
    });
    select.value = assumption.status;
    container.append(node('article', { className: 'assumption-row' }, [
      node('span', { className: `impact-dot impact-dot--${assumption.impact}`, title: `${assumption.impact} impact` }),
      node('div', { className: 'assumption-row__copy' }, [
        node('p', {}, assumption.text),
        node('span', {}, `${assumption.impact} impact`),
      ]),
      select,
    ]));
  });
}

function renderScenarios() {
  const select = byId('scenario-select');
  select.replaceChildren(node('option', { value: 'base' }, 'Base case'));
  stateful.workspace.scenarios.forEach((scenario) => {
    select.append(node('option', { value: scenario.id }, scenario.name));
  });
  select.value = stateful.workspace.activeScenarioId || 'base';
  select.disabled = Boolean(stateful.workspace.committedDecision);
  const scenario = getScenario(stateful.workspace);
  byId('scenario-description').textContent = scenario?.description
    ?? 'The base case uses the evidence and weights in the main matrix.';
}

function renderStressTest() {
  const result = stateful.workspace.lastStressTest;
  const container = byId('stress-results');
  container.replaceChildren();
  if (!result?.results?.length) {
    container.append(node('div', { className: 'stress-empty' }, [
      node('span', { className: 'stress-empty__mark' }, '±'),
      node('p', {}, 'Run a seeded simulation to see whether the leading option survives plausible changes in weights and uncertain scores.'),
    ]));
    return;
  }
  result.results.forEach((item, index) => {
    container.append(node('article', { className: `stress-row${index === 0 ? ' stress-row--leader' : ''}` }, [
      node('div', { className: 'stress-row__headline' }, [
        node('strong', {}, item.option),
        node('span', {}, `${item.winRate.toFixed(1)}% wins`),
      ]),
      node('div', { className: 'win-track', role: 'img', ariaLabel: `${item.option} wins ${item.winRate.toFixed(1)} percent of simulations` }, node('span', { style: `width:${item.winRate}%` })),
      node('small', {}, `Expected ${item.expectedScore.toFixed(2)} · P10–P90 ${item.p10.toFixed(2)}–${item.p90.toFixed(2)}`),
    ]));
  });
  byId('stress-meta').textContent = `${result.iterations.toLocaleString()} simulations · seed ${result.seed}`;
}

function renderGate() {
  const { stagedRecommendation, committedDecision, options } = stateful.workspace;
  const select = byId('recommendation-option');
  select.replaceChildren();
  options.forEach((option) => select.append(node('option', { value: option.id }, option.name)));
  if (stagedRecommendation?.optionId) select.value = stagedRecommendation.optionId;
  select.disabled = Boolean(committedDecision);
  setFieldValue('recommendation-rationale', stagedRecommendation?.rationale ?? '');
  byId('recommendation-rationale').disabled = Boolean(committedDecision);
  byId('stage-recommendation-button').disabled = Boolean(committedDecision) || !options.length;

  const review = byId('staged-review');
  review.replaceChildren();
  if (committedDecision) {
    const option = optionById(committedDecision.optionId);
    review.append(node('div', { className: 'decision-seal' }, [
      node('span', { className: 'decision-seal__mark' }, '✓'),
      node('div', {}, [
        node('span', { className: 'eyebrow' }, 'Human-committed decision'),
        node('h3', {}, option?.name ?? 'Unknown option'),
        node('p', {}, committedDecision.note || 'Decision committed after human review.'),
        node('small', {}, `${formatDate(committedDecision.committedAt)} · You may explicitly undo this commit with “Undo last change”.`),
      ]),
    ]));
  } else if (stagedRecommendation) {
    const option = optionById(stagedRecommendation.optionId);
    review.append(node('div', { className: 'staged-card' }, [
      node('span', { className: 'eyebrow' }, 'Staged for human review'),
      node('h3', {}, option?.name ?? 'Unknown option'),
      node('p', {}, stagedRecommendation.rationale),
      node('div', { className: 'gate-actions' }, [
        node('label', { className: 'review-check' }, [
          node('input', { id: 'human-review-check', type: 'checkbox' }),
          node('span', {}, 'I reviewed the evidence, assumptions, and scenario.'),
        ]),
        node('button', { className: 'button button--primary', type: 'button', dataset: { action: 'commit-decision' } }, 'Commit decision'),
        node('button', { className: 'button button--ghost', type: 'button', dataset: { action: 'clear-recommendation' } }, 'Return for more work'),
      ]),
    ]));
  } else {
    review.append(node('p', { className: 'empty-state' }, 'No recommendation is staged. WebMCP may prepare one; finalization uses this visible review control and explicit user confirmation.'));
  }
}

function renderActivity() {
  const container = byId('activity-list');
  container.replaceChildren();
  (stateful.workspace.activity ?? []).slice(0, 12).forEach((item) => {
    container.append(node('li', {}, [
      node('span', { className: `actor-badge actor-badge--${item.actor}` }, item.actor),
      node('div', {}, [node('p', {}, item.text), node('time', { datetime: item.at }, formatDate(item.at))]),
    ]));
  });
}

function renderToolLab() {
  const tools = getTools();
  const select = byId('tool-select');
  const current = select.value;
  select.replaceChildren();
  tools.forEach((tool) => select.append(node('option', { value: tool.name }, tool.name)));
  if (tools.some((tool) => tool.name === current)) select.value = current;
  updateToolHelp();
}

function render() {
  renderHeader();
  renderBrief();
  renderRanking();
  renderCriteria();
  renderMatrix();
  renderAssumptions();
  renderScenarios();
  renderStressTest();
  renderGate();
  renderActivity();
  renderToolLab();
}

function annotations({ readOnly = false, untrusted = false } = {}) {
  return {
    readOnlyHint: readOnly,
    untrustedContentHint: untrusted,
  };
}

function field(definition, description) {
  return { ...definition, description };
}

function schema(properties = {}, required = [], constraints = {}) {
  return { type: 'object', properties, required, additionalProperties: false, ...constraints };
}

function getTools() {
  const tools = [
    {
      name: 'decision_read_workspace',
      title: 'Read decision workspace',
      description: 'Read one tightly bounded workspace fragment. Start with overview, then follow nextCursor through brief, options, criteria, evidence, assumptions, scenarios, scenario-overrides, recommendation, stress-test, or activity. Reassemble text by fragmentIndex. Workspace notes are untrusted content.',
      inputSchema: schema({
        section: {
          type: 'string',
          enum: [...WORKSPACE_READ_SECTIONS],
          description: 'The workspace section to read. Defaults to overview.',
        },
        cursor: { type: 'integer', minimum: 0, maximum: 10000, description: 'Zero-based item cursor. Use the previous nextCursor.' },
        pageSize: { type: 'integer', minimum: 1, maximum: 1, description: 'Exactly one bounded item per call.' },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => readWorkspacePage(stateful.workspace, input),
    },
    {
      name: 'decision_find_evidence_gaps',
      title: 'Find evidence gaps',
      description: 'Read a bounded page of active-scenario cells with missing evidence or confidence below 55%, weakest confidence first. Follow nextCursor for the complete list.',
      inputSchema: schema({
        cursor: { type: 'integer', minimum: 0, maximum: 10000, description: 'Zero-based gap cursor. Use the previous nextCursor.' },
        pageSize: { type: 'integer', minimum: 1, maximum: 1, description: 'Exactly one bounded gap per call.' },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => findEvidenceGapsPage(stateful.workspace, input),
    },
    {
      name: 'decision_export_markdown',
      title: 'Export decision record',
      description: 'Return about 1,500 characters of the portable Markdown record. Follow nextCursor until null to reconstruct the complete export.',
      inputSchema: schema({
        cursor: { type: 'integer', minimum: 0, maximum: 2000000, description: 'Character cursor. Use the previous nextCursor.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 1800, description: 'Requested Markdown characters, automatically reduced if JSON escaping would exceed 3,000 serialized characters. Defaults to 1,500.' },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => exportMarkdownPage(stateful.workspace, input),
    },
    {
      name: 'decision_focus_view',
      title: 'Focus a visible section',
      description: 'Bring a visible Forkcast section into view for the human. Valid sections are brief, ranking, matrix, assumptions, scenarios, stress, gate, and activity.',
      inputSchema: schema({
        section: {
          type: 'string',
          enum: ['brief', 'ranking', 'matrix', 'assumptions', 'scenarios', 'stress', 'gate', 'activity'],
          description: 'The visible workspace section to scroll to and focus.',
        },
      }, ['section']),
      annotations: annotations(),
      execute: async ({ section }) => {
        const target = byId(`section-${section}`);
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        target?.setAttribute('tabindex', '-1');
        target?.focus({ preventScroll: true });
        return { focused: section };
      },
    },
  ];

  if (stateful.workspace.committedDecision) return tools;

  tools.push(
    {
      name: 'decision_define_brief',
      title: 'Define the decision brief',
      description: 'Update one or more fields in the decision brief. Values remain visible and editable in the page.',
      inputSchema: schema({
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'A short name for this decision workspace.' },
        question: { type: 'string', minLength: 1, maxLength: 300, description: 'The concrete decision question to answer.' },
        context: { type: 'string', maxLength: 4000, description: 'Relevant background, stakeholders, and timing.' },
        constraints: { type: 'string', maxLength: 4000, description: 'Non-negotiable limits or requirements.' },
      }, [], { minProperties: 1 }),
      annotations: annotations({ untrusted: true }),
      execute: async (input) => mutate('Agent updated the decision brief.', (workspace) => {
        workspace.brief = { ...workspace.brief, ...input };
      }),
    },
    {
      name: 'decision_add_option',
      title: 'Add a decision option',
      description: 'Add a viable alternative. New score cells start neutral at 5/10 with 40% confidence so uncertainty remains visible.',
      inputSchema: schema({
        name: field(schemas.shortText, 'The concise name of the alternative.'),
        description: { type: 'string', maxLength: 1000, description: 'What this alternative entails and how it differs.' },
      }, ['name']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length < WORKSPACE_LIMITS.options,
      execute: async ({ name, description = '' }) => {
        const id = makeId('option');
        mutate(`Agent added option “${name}”.`, (workspace) => {
          ensureCapacity(workspace.options, WORKSPACE_LIMITS.options, 'Option');
          workspace.options.push({ id, name, description });
          workspace.scores[id] = Object.fromEntries(workspace.criteria.map((criterion) => [criterion.id, { score: 5, confidence: 40, evidence: '' }]));
        });
        return { optionId: id, workspace: summarizeWorkspace(stateful.workspace) };
      },
    },
    {
      name: 'decision_update_option',
      title: 'Update a decision option',
      description: 'Rename or clarify an existing alternative using its option id.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The option id returned by decision_read_workspace or decision_add_option.'),
        name: { type: 'string', minLength: 1, maxLength: 160, description: 'A replacement name for the alternative.' },
        description: { type: 'string', maxLength: 1000, description: 'A replacement explanation of the alternative.' },
      }, ['optionId'], { minProperties: 2 }),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length > 0,
      execute: async ({ optionId, name, description }) => {
        requireOption(optionId);
        return mutate(`Agent updated option ${optionId}.`, (workspace) => {
          const option = workspace.options.find((item) => item.id === optionId);
          if (name !== undefined) option.name = name;
          if (description !== undefined) option.description = description;
        });
      },
    },
    {
      name: 'decision_remove_option',
      title: 'Remove a decision option',
      description: 'Remove an option and its scores. This destructive operation requires confirm=true and can still be undone.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The exact option id to remove.'),
        confirm: { type: 'boolean', description: 'Set true only after verifying the option id and visible impact.' },
      }, ['optionId', 'confirm']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length > 1,
      execute: async ({ optionId, confirm }) => {
        const option = requireOption(optionId);
        if (!confirm) throw new Error('Set confirm=true after verifying the option id.');
        if (stateful.workspace.options.length <= 1) throw new Error('A decision workspace must keep at least one option.');
        return mutate(`Agent removed option “${option.name}”.`, (workspace) => {
          workspace.options = workspace.options.filter((item) => item.id !== optionId);
          delete workspace.scores[optionId];
          workspace.scenarios.forEach((scenario) => delete scenario.scoreOverrides?.[optionId]);
          if (workspace.stagedRecommendation?.optionId === optionId) workspace.stagedRecommendation = null;
        });
      },
    },
    {
      name: 'decision_add_criterion',
      title: 'Add a decision criterion',
      description: 'Add a decision criterion with a raw weight. Existing options receive neutral score cells.',
      inputSchema: schema({
        name: field(schemas.shortText, 'The value or outcome used to judge every option.'),
        description: { type: 'string', maxLength: 1000, description: 'How to interpret and score this criterion.' },
        weight: field(schemas.weight, 'Relative importance from 0 to 100; all weights are normalized.'),
      }, ['name', 'weight']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.criteria.length < WORKSPACE_LIMITS.criteria,
      execute: async ({ name, description = '', weight }) => {
        const id = makeId('criterion');
        mutate(`Agent added criterion “${name}”.`, (workspace) => {
          ensureCapacity(workspace.criteria, WORKSPACE_LIMITS.criteria, 'Criterion');
          workspace.criteria.push({ id, name, description, weight });
          workspace.options.forEach((option) => {
            workspace.scores[option.id] ??= {};
            workspace.scores[option.id][id] = { score: 5, confidence: 40, evidence: '' };
          });
        });
        return { criterionId: id, workspace: summarizeWorkspace(stateful.workspace) };
      },
    },
    {
      name: 'decision_set_criterion_weight',
      title: 'Set a criterion weight',
      description: 'Set a raw criterion weight in the base case or an existing scenario. Forkcast normalizes all weights automatically.',
      inputSchema: schema({
        criterionId: field(schemas.id, 'The criterion id whose importance should change.'),
        weight: field(schemas.weight, 'Relative importance from 0 to 100.'),
        scenarioId: field(schemas.id, 'The scenario id to change, or base for the base case. Defaults to base.'),
      }, ['criterionId', 'weight']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.criteria.length > 0,
      execute: async ({ criterionId, weight, scenarioId = 'base' }) => {
        const criterion = requireCriterion(criterionId);
        if (scenarioId !== 'base' && !stateful.workspace.scenarios.some((item) => item.id === scenarioId)) throw new Error(`Unknown scenario id: ${scenarioId}`);
        return mutate(`Agent set ${criterion.name} weight to ${weight} in ${scenarioId}.`, (workspace) => {
          if (scenarioId === 'base') workspace.criteria.find((item) => item.id === criterionId).weight = weight;
          else {
            const scenario = workspace.scenarios.find((item) => item.id === scenarioId);
            scenario.weightOverrides ??= {};
            scenario.weightOverrides[criterionId] = weight;
          }
        });
      },
    },
    {
      name: 'decision_score_option',
      title: 'Score an option',
      description: 'Record an option score, confidence, and evidence for a criterion in the base case or a scenario. Evidence is user-authored, untrusted content.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The option id to evaluate.'),
        criterionId: field(schemas.id, 'The criterion id to score against.'),
        score: field(schemas.score, 'Evaluation from 0 (worst) to 10 (best).'),
        confidence: field(schemas.confidence, 'Confidence from 0 to 100 based on evidence quality.'),
        evidence: { type: 'string', maxLength: 2000, description: 'A concise source, observation, or rationale supporting the score.' },
        scenarioId: field(schemas.id, 'The scenario id to score, or base. Defaults to base.'),
      }, ['optionId', 'criterionId', 'score', 'confidence']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length > 0 && stateful.workspace.criteria.length > 0,
      execute: async ({ optionId, criterionId, score, confidence, evidence = '', scenarioId = 'base' }) => {
        const option = requireOption(optionId);
        const criterion = requireCriterion(criterionId);
        if (scenarioId !== 'base' && !stateful.workspace.scenarios.some((item) => item.id === scenarioId)) throw new Error(`Unknown scenario id: ${scenarioId}`);
        return mutate(`Agent scored ${option.name} on ${criterion.name}.`, (workspace) => {
          const cell = { score, confidence, evidence };
          if (scenarioId === 'base') {
            workspace.scores[optionId] ??= {};
            workspace.scores[optionId][criterionId] = cell;
          } else {
            const scenario = workspace.scenarios.find((item) => item.id === scenarioId);
            scenario.scoreOverrides ??= {};
            scenario.scoreOverrides[optionId] ??= {};
            scenario.scoreOverrides[optionId][criterionId] = cell;
          }
        });
      },
    },
    {
      name: 'decision_add_assumption',
      title: 'Add an assumption',
      description: 'Add an explicit unknown to the assumption ledger so it can be tested rather than hidden in prose.',
      inputSchema: schema({
        text: { type: 'string', minLength: 1, maxLength: 1000, description: 'A falsifiable statement that could change the decision.' },
        impact: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How much the decision could change if this assumption is wrong.' },
        status: { type: 'string', enum: ['open', 'testing', 'validated', 'invalidated'], description: 'Current validation state. Defaults to open.' },
      }, ['text', 'impact']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.assumptions.length < WORKSPACE_LIMITS.assumptions,
      execute: async ({ text: assumptionText, impact, status = 'open' }) => {
        const id = makeId('assumption');
        mutate('Agent added an assumption.', (workspace) => {
          ensureCapacity(workspace.assumptions, WORKSPACE_LIMITS.assumptions, 'Assumption');
          workspace.assumptions.push({ id, text: assumptionText, impact, status });
        });
        return { assumptionId: id, workspace: summarizeWorkspace(stateful.workspace) };
      },
    },
    {
      name: 'decision_set_assumption_status',
      title: 'Set an assumption status',
      description: 'Update an assumption as evidence is gathered.',
      inputSchema: schema({
        assumptionId: field(schemas.id, 'The assumption id to update.'),
        status: { type: 'string', enum: ['open', 'testing', 'validated', 'invalidated'], description: 'The new evidence-validation state.' },
      }, ['assumptionId', 'status']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.assumptions.length > 0,
      execute: async ({ assumptionId, status }) => {
        if (!stateful.workspace.assumptions.some((item) => item.id === assumptionId)) throw new Error(`Unknown assumption id: ${assumptionId}`);
        return mutate(`Agent marked assumption ${assumptionId} as ${status}.`, (workspace) => {
          workspace.assumptions.find((item) => item.id === assumptionId).status = status;
        });
      },
    },
    {
      name: 'decision_create_scenario',
      title: 'Create a scenario',
      description: 'Create a named what-if scenario. Weight overrides use criterion ids; score overrides can be added later with decision_score_option.',
      inputSchema: schema({
        name: field(schemas.shortText, 'A short, distinct name for the what-if future.'),
        description: { type: 'string', maxLength: 2000, description: 'What changes in this future and why it matters.' },
      }, ['name']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.scenarios.length < WORKSPACE_LIMITS.scenarios,
      execute: async ({ name, description = '' }) => {
        const id = makeId('scenario');
        mutate(`Agent created scenario “${name}”.`, (workspace) => {
          ensureCapacity(workspace.scenarios, WORKSPACE_LIMITS.scenarios, 'Scenario');
          workspace.scenarios.push({ id, name, description, weightOverrides: {}, scoreOverrides: {} });
        });
        return { scenarioId: id, workspace: summarizeWorkspace(stateful.workspace) };
      },
    },
    {
      name: 'decision_activate_scenario',
      title: 'Activate a scenario',
      description: 'Activate the base case or a named scenario so the visible ranking and matrix reflect it.',
      inputSchema: schema({ scenarioId: field(schemas.id, 'The scenario id to show, or base for the base case.') }, ['scenarioId']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.scenarios.length > 0 || stateful.workspace.activeScenarioId !== 'base',
      execute: async ({ scenarioId }) => {
        if (scenarioId !== 'base' && !stateful.workspace.scenarios.some((item) => item.id === scenarioId)) throw new Error(`Unknown scenario id: ${scenarioId}`);
        return mutate(`Agent activated scenario ${scenarioId}.`, (workspace) => { workspace.activeScenarioId = scenarioId; });
      },
    },
    {
      name: 'decision_run_stress_test',
      title: 'Run an uncertainty stress test',
      description: 'Run a deterministic Monte Carlo stress test and save the visible result. Lower-confidence cells vary more widely.',
      inputSchema: schema({
        iterations: { type: 'integer', minimum: 100, maximum: 10000, description: 'Number of simulations. Defaults to 1000.' },
        seed: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Random seed for a reproducible result.' },
      }),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length > 0 && stateful.workspace.criteria.length > 0,
      execute: async ({ iterations = 1000, seed = 20260828 }, { signal } = {}) => {
        const result = await runStressTest(stateful.workspace, { iterations, seed, signal });
        if (signal?.aborted) {
          if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
          throw signal.reason ?? new DOMException('The stress test was aborted.', 'AbortError');
        }
        const workspace = mutate(`Agent ran ${result.iterations} stress-test simulations.`, (next) => { next.lastStressTest = result; });
        return {
          workspace,
          stressTest: {
            iterations: result.iterations,
            seed: result.seed,
            scenarioId: result.scenarioId,
            generatedAt: result.generatedAt,
            resultCount: result.results.length,
            leader: result.results[0] ?? null,
            resultSection: 'stress-test',
          },
        };
      },
    },
    {
      name: 'decision_stage_recommendation',
      title: 'Stage a recommendation',
      description: 'Stage an option and rationale for human review. This does not commit the decision; Forkcast intentionally exposes no final-commit tool.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The option id to recommend for human review.'),
        rationale: field(schemas.longText, 'Why this option leads, what remains uncertain, and what must be true.'),
      }, ['optionId', 'rationale']),
      annotations: annotations({ untrusted: true }),
      available: stateful.workspace.options.length > 0,
      execute: async ({ optionId, rationale }) => {
        const option = requireOption(optionId);
        return mutate(`Agent staged “${option.name}” for human review.`, (workspace) => {
          workspace.stagedRecommendation = { optionId, rationale, stagedAt: new Date().toISOString(), actor: 'agent' };
        });
      },
    },
    {
      name: 'decision_clear_staged_recommendation',
      title: 'Clear the staged recommendation',
      description: 'Clear the staged recommendation and return the workspace for more analysis.',
      inputSchema: schemas.empty,
      annotations: annotations({ untrusted: true }),
      available: Boolean(stateful.workspace.stagedRecommendation),
      execute: async () => mutate('Agent cleared the staged recommendation.', (workspace) => { workspace.stagedRecommendation = null; }),
    },
    {
      name: 'decision_undo_last_change',
      title: 'Undo the latest agent change',
      description: 'Undo the latest workspace mutation only when it was made by an agent. Human edits and final commitment are outside this tool’s authority.',
      inputSchema: schemas.empty,
      annotations: annotations({ untrusted: true }),
      available: stateful.undoStack.at(-1)?.actor === 'agent',
      execute: async () => undoLast('agent'),
    },
  );
  return tools
    .filter(({ available = true }) => available)
    .map(({ available: _available, ...tool }) => tool);
}

function refreshTools() {
  stateful.webmcp = installWebMCP(getTools(), {
    onStatus: ({ mode, toolCount, message, error }) => {
      const badge = byId('webmcp-status');
      if (!badge) return;
      badge.dataset.mode = mode;
      badge.querySelector('strong').textContent = message;
      badge.querySelector('span').textContent = error ? `${toolCount} tools · native unavailable` : `${toolCount} tools`;
      badge.title = error ? `Native registration failed: ${error}` : '';
    },
  });
}

function openDialog(id) {
  const dialog = byId(id);
  if (dialog?.showModal) dialog.showModal();
}

function closeDialog(id) {
  byId(id)?.close();
}

function populateBriefForm() {
  const { brief } = stateful.workspace;
  setFieldValue('brief-title-input', brief.title);
  setFieldValue('brief-question-input', brief.question);
  setFieldValue('brief-context-input', brief.context);
  setFieldValue('brief-constraints-input', brief.constraints);
}

function populateOptionForm(optionId = '') {
  const option = optionId ? optionById(optionId) : null;
  byId('option-dialog-title').textContent = option ? 'Edit option' : 'Add option';
  byId('option-id-input').value = option?.id ?? '';
  byId('option-name-input').value = option?.name ?? '';
  byId('option-description-input').value = option?.description ?? '';
  byId('remove-option-button').hidden = !option;
}

function populateScoreForm(optionId, criterionId) {
  const option = requireOption(optionId);
  const criterion = requireCriterion(criterionId);
  const cell = effectiveCell(stateful.workspace, optionId, criterionId);
  byId('score-dialog-title').textContent = `${option.name} × ${criterion.name}`;
  byId('score-option-id').value = optionId;
  byId('score-criterion-id').value = criterionId;
  byId('score-input').value = String(cell.score);
  byId('confidence-input').value = String(cell.confidence);
  byId('evidence-input').value = cell.evidence;
  byId('score-value').textContent = Number(cell.score).toFixed(1);
  byId('confidence-value').textContent = `${Number(cell.confidence).toFixed(0)}%`;
  const scenario = getScenario(stateful.workspace);
  byId('score-scenario-note').textContent = scenario ? `Editing override in scenario “${scenario.name}”.` : 'Editing the base-case score.';
}

function updateToolHelp() {
  const name = byId('tool-select')?.value;
  const tool = getTools().find((item) => item.name === name);
  if (!tool) return;
  byId('tool-description').textContent = tool.description;
  byId('tool-schema').textContent = JSON.stringify(tool.inputSchema, null, 2);
  const input = byId('tool-input');
  if (!input.dataset.dirty || input.dataset.tool !== name) {
    input.value = name === 'decision_read_workspace' || Object.keys(tool.inputSchema.properties ?? {}).length === 0 ? '{}' : sampleInput(name);
    input.dataset.tool = name;
    input.dataset.dirty = '';
  }
}

function sampleInput(name) {
  const optionId = stateful.workspace.options[0]?.id ?? 'option-id';
  const criterionId = stateful.workspace.criteria[0]?.id ?? 'criterion-id';
  const assumptionId = stateful.workspace.assumptions[0]?.id ?? 'assumption-id';
  const scenarioId = stateful.workspace.scenarios[0]?.id ?? 'base';
  const samples = {
    decision_focus_view: { section: 'matrix' },
    decision_define_brief: { question: 'Which option best balances learning, reach, workload, and revenue?' },
    decision_add_option: { name: 'Partner-led launch', description: 'Launch with a specialist distribution partner.' },
    decision_update_option: { optionId, description: 'Clarified scope and operating model.' },
    decision_remove_option: { optionId, confirm: false },
    decision_add_criterion: { name: 'Reversibility', description: 'How easily the team can change course.', weight: 20 },
    decision_set_criterion_weight: { criterionId, weight: 30, scenarioId: 'base' },
    decision_score_option: { optionId, criterionId, score: 7.5, confidence: 65, evidence: 'Pilot interviews and comparable launch data.' },
    decision_add_assumption: { text: 'The launch partner can meet the target date.', impact: 'high', status: 'open' },
    decision_set_assumption_status: { assumptionId, status: 'testing' },
    decision_create_scenario: { name: 'Demand spike', description: 'Inbound interest doubles after an industry announcement.' },
    decision_activate_scenario: { scenarioId },
    decision_stage_recommendation: { optionId, rationale: 'This option leads the base case and remains robust under current scenarios. Validate the two highest-impact assumptions before commitment.' },
    decision_run_stress_test: { iterations: 1000, seed: 20260828 },
  };
  return JSON.stringify(samples[name] ?? {}, null, 2);
}

function formatToolLabValue(value) {
  if (value === undefined) return 'Tool completed with no return value.';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function formatToolLabError(error) {
  return JSON.stringify({
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  }, null, 2);
}

function downloadMarkdown() {
  const markdown = exportMarkdown(stateful.workspace);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = (stateful.workspace.brief.title || 'forkcast-decision').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  anchor.href = url;
  anchor.download = `${slug || 'forkcast-decision'}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('Markdown decision record exported.', 'success');
}

function bindSubmit(id, handler) {
  byId(id).addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      handler(event);
    } catch (error) {
      toast(error.message || 'The change could not be saved.', 'error');
    }
  });
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action } = button.dataset;
    try {
      if (action === 'edit-brief') {
        populateBriefForm();
        openDialog('brief-dialog');
      } else if (action === 'add-option') {
        populateOptionForm();
        openDialog('option-dialog');
      } else if (action === 'edit-option') {
        populateOptionForm(button.dataset.optionId);
        openDialog('option-dialog');
      } else if (action === 'edit-score') {
        populateScoreForm(button.dataset.optionId, button.dataset.criterionId);
        openDialog('score-dialog');
      } else if (action === 'add-criterion') {
        byId('criterion-form').reset();
        byId('criterion-weight-input').value = '20';
        openDialog('criterion-dialog');
      } else if (action === 'add-assumption') {
        byId('assumption-form').reset();
        openDialog('assumption-dialog');
      } else if (action === 'add-scenario') {
        byId('scenario-form').reset();
        openDialog('scenario-dialog');
      } else if (action === 'run-stress') {
        const result = await runStressTest(stateful.workspace, { iterations: 2000, seed: 20260828 });
        mutate(`Human ran ${result.iterations} stress-test simulations.`, (workspace) => { workspace.lastStressTest = result; }, { actor: 'human' });
        toast('Stress test complete.', 'success');
      } else if (action === 'open-tool-lab') {
        renderToolLab();
        openDialog('tool-dialog');
      } else if (action === 'export') {
        downloadMarkdown();
      } else if (action === 'undo') {
        undoLast('human');
        toast('Latest change undone.', 'success');
      } else if (action === 'clear-recommendation') {
        mutate('Human returned the recommendation for more work.', (workspace) => { workspace.stagedRecommendation = null; }, { actor: 'human' });
      } else if (action === 'commit-decision') {
        const check = byId('human-review-check');
        if (!check?.checked) throw new Error('Confirm that you reviewed the evidence, assumptions, and scenario first.');
        const staged = stateful.workspace.stagedRecommendation;
        if (!staged) throw new Error('Stage a recommendation before committing.');
        mutate('Human committed the final decision.', (workspace) => {
          workspace.committedDecision = {
            optionId: staged.optionId,
            note: staged.rationale,
            committedAt: new Date().toISOString(),
          };
        }, { actor: 'human' });
        toast('Decision committed by human review.', 'success');
      } else if (action === 'reset-workspace') {
        if (confirm('Replace the current workspace with a blank decision?')) replaceWorkspace(createBlankWorkspace(), 'Started a blank decision workspace.');
      } else if (action === 'toggle-theme') {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_KEY, next);
      } else if (action === 'close-dialog') {
        button.closest('dialog')?.close();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  byId('example-select').addEventListener('change', (event) => {
    const key = event.target.value;
    if (!key) return;
    const example = examples[key];
    if (example && confirm(`Load the “${example.label}” example and replace the current workspace?`)) {
      replaceWorkspace(getExample(key), `Loaded the ${example.label} example.`);
      toast(`${example.label} example loaded.`, 'success');
    }
    event.target.value = '';
  });

  byId('scenario-select').addEventListener('change', (event) => {
    try {
      mutate(`Human activated scenario ${event.target.value}.`, (workspace) => { workspace.activeScenarioId = event.target.value; }, { actor: 'human' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  byId('criteria-list').addEventListener('change', (event) => {
    const input = event.target.closest('[data-action="criterion-weight"]');
    if (!input) return;
    try {
      const criterionId = input.dataset.criterionId;
      const value = Number(input.value);
      const scenarioId = stateful.workspace.activeScenarioId || 'base';
      mutate(`Human changed ${criterionById(criterionId)?.name ?? criterionId} weight.`, (workspace) => {
        if (scenarioId === 'base') workspace.criteria.find((item) => item.id === criterionId).weight = value;
        else {
          const scenario = workspace.scenarios.find((item) => item.id === scenarioId);
          scenario.weightOverrides ??= {};
          scenario.weightOverrides[criterionId] = value;
        }
      }, { actor: 'human' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  byId('assumption-list').addEventListener('change', (event) => {
    const select = event.target.closest('[data-action="assumption-status"]');
    if (!select) return;
    try {
      mutate(`Human marked an assumption as ${select.value}.`, (workspace) => {
        workspace.assumptions.find((item) => item.id === select.dataset.assumptionId).status = select.value;
      }, { actor: 'human' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  bindSubmit('brief-form', (event) => {
    const data = new FormData(event.currentTarget);
    mutate('Human updated the decision brief.', (workspace) => {
      workspace.brief = {
        title: String(data.get('title')).trim(),
        question: String(data.get('question')).trim(),
        context: String(data.get('context')).trim(),
        constraints: String(data.get('constraints')).trim(),
      };
    }, { actor: 'human' });
    closeDialog('brief-dialog');
  });

  bindSubmit('option-form', (event) => {
    const data = new FormData(event.currentTarget);
    const id = String(data.get('id'));
    const name = String(data.get('name')).trim();
    const description = String(data.get('description')).trim();
    if (!name) return toast('Option name is required.', 'error');
    if (id) {
      mutate(`Human updated option “${name}”.`, (workspace) => Object.assign(workspace.options.find((item) => item.id === id), { name, description }), { actor: 'human' });
    } else {
      const newId = makeId('option');
      mutate(`Human added option “${name}”.`, (workspace) => {
        ensureCapacity(workspace.options, WORKSPACE_LIMITS.options, 'Option');
        workspace.options.push({ id: newId, name, description });
        workspace.scores[newId] = Object.fromEntries(workspace.criteria.map((criterion) => [criterion.id, { score: 5, confidence: 40, evidence: '' }]));
      }, { actor: 'human' });
    }
    closeDialog('option-dialog');
  });

  byId('remove-option-button').addEventListener('click', () => {
    const id = byId('option-id-input').value;
    const option = optionById(id);
    if (!option || stateful.workspace.options.length <= 1) return toast('A workspace must keep at least one option.', 'error');
    if (!confirm(`Remove “${option.name}”? This can be undone.`)) return;
    mutate(`Human removed option “${option.name}”.`, (workspace) => {
      workspace.options = workspace.options.filter((item) => item.id !== id);
      delete workspace.scores[id];
      workspace.scenarios.forEach((scenario) => delete scenario.scoreOverrides?.[id]);
      if (workspace.stagedRecommendation?.optionId === id) workspace.stagedRecommendation = null;
    }, { actor: 'human' });
    closeDialog('option-dialog');
  });

  bindSubmit('score-form', (event) => {
    const data = new FormData(event.currentTarget);
    const optionId = String(data.get('optionId'));
    const criterionId = String(data.get('criterionId'));
    const cell = {
      score: Number(data.get('score')),
      confidence: Number(data.get('confidence')),
      evidence: String(data.get('evidence')).trim(),
    };
    const scenarioId = stateful.workspace.activeScenarioId || 'base';
    mutate(`Human scored ${optionById(optionId)?.name} on ${criterionById(criterionId)?.name}.`, (workspace) => {
      if (scenarioId === 'base') workspace.scores[optionId][criterionId] = cell;
      else {
        const scenario = workspace.scenarios.find((item) => item.id === scenarioId);
        scenario.scoreOverrides ??= {};
        scenario.scoreOverrides[optionId] ??= {};
        scenario.scoreOverrides[optionId][criterionId] = cell;
      }
    }, { actor: 'human' });
    closeDialog('score-dialog');
  });

  byId('score-input').addEventListener('input', (event) => { byId('score-value').textContent = Number(event.target.value).toFixed(1); });
  byId('confidence-input').addEventListener('input', (event) => { byId('confidence-value').textContent = `${Number(event.target.value).toFixed(0)}%`; });

  bindSubmit('criterion-form', (event) => {
    const data = new FormData(event.currentTarget);
    const id = makeId('criterion');
    const name = String(data.get('name')).trim();
    const description = String(data.get('description')).trim();
    const weight = Number(data.get('weight'));
    mutate(`Human added criterion “${name}”.`, (workspace) => {
      ensureCapacity(workspace.criteria, WORKSPACE_LIMITS.criteria, 'Criterion');
      workspace.criteria.push({ id, name, description, weight });
      workspace.options.forEach((option) => {
        workspace.scores[option.id] ??= {};
        workspace.scores[option.id][id] = { score: 5, confidence: 40, evidence: '' };
      });
    }, { actor: 'human' });
    closeDialog('criterion-dialog');
  });

  bindSubmit('assumption-form', (event) => {
    const data = new FormData(event.currentTarget);
    mutate('Human added an assumption.', (workspace) => {
      ensureCapacity(workspace.assumptions, WORKSPACE_LIMITS.assumptions, 'Assumption');
      workspace.assumptions.push({
        id: makeId('assumption'),
        text: String(data.get('text')).trim(),
        impact: String(data.get('impact')),
        status: 'open',
      });
    }, { actor: 'human' });
    closeDialog('assumption-dialog');
  });

  bindSubmit('scenario-form', (event) => {
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name')).trim();
    const id = makeId('scenario');
    mutate(`Human created scenario “${name}”.`, (workspace) => {
      ensureCapacity(workspace.scenarios, WORKSPACE_LIMITS.scenarios, 'Scenario');
      workspace.scenarios.push({ id, name, description: String(data.get('description')).trim(), weightOverrides: {}, scoreOverrides: {} });
      workspace.activeScenarioId = id;
    }, { actor: 'human' });
    closeDialog('scenario-dialog');
  });

  bindSubmit('recommendation-form', (event) => {
    const data = new FormData(event.currentTarget);
    const optionId = String(data.get('optionId'));
    const rationale = String(data.get('rationale')).trim();
    if (!rationale) return toast('Add a rationale before staging the recommendation.', 'error');
    mutate(`Human staged “${optionById(optionId)?.name}” for review.`, (workspace) => {
      workspace.stagedRecommendation = { optionId, rationale, stagedAt: new Date().toISOString(), actor: 'human' };
    }, { actor: 'human' });
    toast('Recommendation staged. Final commitment still requires review.', 'success');
  });

  byId('tool-select').addEventListener('change', updateToolHelp);
  byId('tool-input').addEventListener('input', (event) => { event.target.dataset.dirty = 'true'; });
  byId('tool-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const output = byId('tool-output');
    output.textContent = 'Running…';
    try {
      const input = JSON.parse(byId('tool-input').value || '{}');
      const result = await stateful.webmcp.execute(byId('tool-select').value, input);
      output.textContent = formatToolLabValue(result);
      toast('Tool completed.', 'success');
    } catch (error) {
      output.textContent = formatToolLabError(error);
      toast(error.message, 'error');
    }
  });

  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

function initializeTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = saved || preferred;
}

function boot() {
  initializeTheme();
  bindEvents();
  render();
  refreshTools();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed.', error));
  }
  addEventListener('pagehide', uninstallWebMCP, { once: true });
}

boot();
