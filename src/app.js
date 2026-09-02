import {
  deepClone,
  effectiveCell,
  exportMarkdown,
  findEvidenceGaps,
  getScenario,
  isStressTestStale,
  makeId,
  normalizeWorkspace,
  normalizedWeights,
  rankOptions,
  runStressTest,
  setScoreCell,
  summarizeWorkspace,
  WORKSPACE_LIMITS,
} from './engine.js';
import { createBlankWorkspace, examples, getExample } from './data.js';
import { commitWorkspaceSnapshot, restoreWorkspace } from './storage.js';
import {
  createTools,
  describeRemoval,
  ensureCapacity,
  neutralCells,
  removeOption,
  requireCriterion,
  requireOption,
  snapshotOption,
} from './tools.js';
import { installWebMCP, uninstallWebMCP } from './webmcp.js';

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
  stressRun: null,
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

/** CSSOM writes are allowed under a strict style-src; inline style attributes are not. */
function bar(percent) {
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.max(0, Number(percent) || 0))}%`;
  return fill;
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
  if (!entry) throw new Error(actor === 'agent' ? 'There is no agent change to undo.' : 'There is no change to undo.');
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
          bar((item.score / max) * 100)),
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

  const scenario = getScenario(stateful.workspace);
  table.append(node('caption', { className: 'sr-only' }, `Evidence matrix for ${scenario ? `scenario “${scenario.name}”` : 'the base case'}: rows are criteria with normalized weights, columns are options; each cell shows score out of 10, confidence, and whether evidence is recorded.`));
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
  const button = byId('run-stress-button');
  const running = Boolean(stateful.stressRun);
  button.textContent = running ? 'Cancel' : 'Run 2k';
  button.setAttribute('aria-pressed', String(running));
  button.disabled = Boolean(stateful.workspace.committedDecision) && !running;
  container.setAttribute('aria-busy', String(running));
  container.replaceChildren();
  if (!result?.results?.length) {
    container.append(node('div', { className: 'stress-empty' }, [
      node('span', { className: 'stress-empty__mark' }, '±'),
      node('p', {}, running
        ? 'Running 2,000 seeded simulations…'
        : 'Run a seeded simulation to see whether the leading option survives plausible changes in weights and uncertain scores.'),
    ]));
    byId('stress-meta').textContent = '';
    return;
  }
  const stale = isStressTestStale(stateful.workspace, result);
  container.classList.toggle('stress-results--stale', stale);
  if (stale) {
    container.append(node('p', { className: 'stress-stale', role: 'status' }, 'Stale: scores, weights, or options changed after this run. Run again to refresh.'));
  }
  result.results.forEach((item, index) => {
    container.append(node('article', { className: `stress-row${index === 0 ? ' stress-row--leader' : ''}` }, [
      node('div', { className: 'stress-row__headline' }, [
        node('strong', {}, item.option),
        node('span', {}, `${item.winRate.toFixed(1)}% wins`),
      ]),
      node('div', { className: 'win-track', role: 'img', ariaLabel: `${item.option} wins ${item.winRate.toFixed(1)} percent of simulations` }, bar(item.winRate)),
      node('small', {}, `Expected ${item.expectedScore.toFixed(2)} · P10–P90 ${item.p10.toFixed(2)}–${item.p90.toFixed(2)}`),
    ]));
  });
  const scenarioName = getScenario(stateful.workspace, result.scenarioId)?.name ?? 'Base case';
  byId('stress-meta').textContent = `${result.iterations.toLocaleString()} simulations · seed ${result.seed} · ${scenarioName}${running ? ' · running a new run…' : ''}`;
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
  const previousCheck = byId('human-review-check');
  const stagedKey = stagedRecommendation ? `${stagedRecommendation.optionId}@${stagedRecommendation.stagedAt}` : '';
  const keepChecked = Boolean(previousCheck?.checked) && previousCheck.dataset.staged === stagedKey;
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
          node('input', { id: 'human-review-check', type: 'checkbox', checked: keepChecked, dataset: { staged: stagedKey } }),
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

/**
 * Rendering replaces subtrees wholesale, so remember which control had focus
 * (by id, or by its data-* identity for generated controls) and restore it.
 */
function focusKey(element) {
  if (!(element instanceof Element) || element === document.body) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const entries = Object.entries(element.dataset);
  if (!entries.length) return null;
  const selector = entries
    .map(([key, value]) => `[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(value)}"]`)
    .join('');
  return `${element.tagName.toLowerCase()}${selector}`;
}

function restoreFocus(key) {
  if (!key || document.activeElement !== document.body) return;
  const target = document.querySelector(key);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function render() {
  const focused = focusKey(document.activeElement);
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
  restoreFocus(focused);
}

function focusSection(section) {
  const target = byId(`section-${section}`);
  if (!target) throw new Error(`Unknown section: ${section}`);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

function getTools() {
  return createTools({
    getWorkspace: () => stateful.workspace,
    getUndoStack: () => stateful.undoStack,
    mutate,
    undo: undoLast,
    focus: focusSection,
  });
}

const NATIVE_HINT = 'Enable chrome://flags/#enable-webmcp-testing (Chrome 150+) or open in the ChatGPT in-app browser, then reload.';

function describeStatus({ mode, toolCount, reason, error }) {
  if (mode !== 'preview') return `${toolCount} tools`;
  if (reason === 'embedded') return `${toolCount} tools · native registration is disabled inside an embedded frame. Open Forkcast in its own tab.`;
  if (error) return `${toolCount} tools · native registration failed: ${error}`;
  return `${toolCount} tools · ${NATIVE_HINT}`;
}

function refreshTools() {
  stateful.webmcp = installWebMCP(getTools(), {
    onStatus: (state) => {
      const badge = byId('webmcp-status');
      if (!badge) return;
      badge.dataset.mode = state.mode;
      badge.querySelector('strong').textContent = state.message;
      badge.querySelector('span').textContent = describeStatus(state);
      badge.title = state.error ? `Native registration failed: ${state.error}` : '';
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
  const option = requireOption(stateful.workspace, optionId);
  const criterion = requireCriterion(stateful.workspace, criterionId);
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
    decision_remove_option: { optionId },
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

function workspaceSlug() {
  const slug = (stateful.workspace.brief.title || 'forkcast-decision').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'forkcast-decision';
}

function downloadFile(contents, filename, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadMarkdown() {
  downloadFile(exportMarkdown(stateful.workspace), `${workspaceSlug()}.md`, 'text/markdown;charset=utf-8');
  toast('Markdown decision record exported.', 'success');
}

function downloadWorkspaceJson() {
  downloadFile(JSON.stringify(stateful.workspace, null, 2), `${workspaceSlug()}.forkcast.json`, 'application/json;charset=utf-8');
  toast('Workspace JSON exported.', 'success');
}

async function importWorkspaceFile(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(`“${file.name}” is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.options) || !Array.isArray(parsed.criteria)) {
    throw new Error(`“${file.name}” is not a Forkcast workspace export.`);
  }
  const candidate = normalizeWorkspace(parsed, createBlankWorkspace());
  if (!confirm(`Replace the current workspace with “${candidate.brief.title}” from ${file.name}? Undo remains available.`)) return;
  replaceWorkspace(candidate, `Imported workspace from ${file.name}.`);
  toast('Workspace imported.', 'success');
}

function showStorageNotice(message) {
  const notice = byId('storage-notice');
  if (!notice) return;
  byId('storage-notice-text').textContent = message;
  notice.hidden = false;
}

async function toggleHumanStressTest() {
  if (stateful.stressRun) {
    stateful.stressRun.abort(new DOMException('Stress test cancelled.', 'AbortError'));
    return;
  }
  ensureMutable();
  const controller = new AbortController();
  stateful.stressRun = controller;
  renderStressTest();
  try {
    const scenarioId = stateful.workspace.activeScenarioId || 'base';
    const result = await runStressTest(stateful.workspace, { iterations: 2000, seed: 20260828, scenarioId, signal: controller.signal });
    stateful.stressRun = null;
    const scenario = getScenario(stateful.workspace, scenarioId);
    mutate(`Human ran ${result.iterations} stress-test simulations on ${scenario ? `scenario “${scenario.name}”` : 'the base case'}.`, (workspace) => { workspace.lastStressTest = result; }, { actor: 'human' });
    toast('Stress test complete.', 'success');
  } catch (error) {
    stateful.stressRun = null;
    renderStressTest();
    if (error?.name === 'AbortError') toast('Stress test cancelled.', 'default');
    else throw error;
  }
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
        await toggleHumanStressTest();
      } else if (action === 'open-tool-lab') {
        renderToolLab();
        openDialog('tool-dialog');
      } else if (action === 'export') {
        downloadMarkdown();
      } else if (action === 'export-json') {
        downloadWorkspaceJson();
      } else if (action === 'import-json') {
        byId('import-file').click();
      } else if (action === 'dismiss-notice') {
        byId('storage-notice').hidden = true;
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

  byId('import-file').addEventListener('change', async (event) => {
    const [file] = event.target.files ?? [];
    event.target.value = '';
    try {
      await importWorkspaceFile(file);
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
      const scenario = getScenario(stateful.workspace, event.target.value);
      mutate(`Human activated ${scenario ? `scenario “${scenario.name}”` : 'the base case'}.`, (workspace) => { workspace.activeScenarioId = event.target.value; }, { actor: 'human' });
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
        workspace.scores[newId] = neutralCells(workspace.criteria);
      }, { actor: 'human' });
    }
    closeDialog('option-dialog');
  });

  byId('remove-option-button').addEventListener('click', () => {
    const id = byId('option-id-input').value;
    const option = optionById(id);
    if (!option || stateful.workspace.options.length <= 1) return toast('A workspace must keep at least one option.', 'error');
    if (!confirm(`Remove “${option.name}”? This can be undone.`)) return;
    const snapshot = snapshotOption(stateful.workspace, id);
    mutate(describeRemoval('Human', snapshot), (workspace) => removeOption(workspace, id), { actor: 'human' });
    closeDialog('option-dialog');
  });

  bindSubmit('score-form', (event) => {
    const data = new FormData(event.currentTarget);
    const optionId = String(data.get('optionId'));
    const criterionId = String(data.get('criterionId'));
    const scenarioId = stateful.workspace.activeScenarioId || 'base';
    mutate(`Human scored ${optionById(optionId)?.name} on ${criterionById(criterionId)?.name}.`, (workspace) => {
      setScoreCell(workspace, {
        optionId,
        criterionId,
        score: Number(data.get('score')),
        confidence: Number(data.get('confidence')),
        evidence: String(data.get('evidence')).trim(),
        scenarioId,
      });
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
  if (restored.warning) {
    showStorageNotice(`${restored.warning.message} Your next change overwrites the unreadable copy. Use “Import” to restore a JSON export if you have one.`);
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed.', error));
  }
  // Unregister when the page is hidden (including bfcache entry) and register
  // again when it is restored from the back/forward cache.
  addEventListener('pagehide', uninstallWebMCP);
  addEventListener('pageshow', (event) => {
    if (event.persisted) refreshTools();
  });
}

boot();
