import test from 'node:test';
import assert from 'node:assert/strict';
import { getExample } from '../src/data.js';
import {
  effectiveCell,
  exportMarkdown,
  exportMarkdownPage,
  findEvidenceGaps,
  findEvidenceGapsPage,
  isStressTestStale,
  normalizeWorkspace,
  normalizedWeights,
  rankOptions,
  readWorkspacePage,
  runStressTest,
  setScoreCell,
  stressFingerprint,
  summarizeWorkspace,
  TOOL_RESULT_LIMITS,
  WORKSPACE_LIMITS,
  WORKSPACE_READ_SECTIONS,
} from '../src/engine.js';
import { schemas, validateInput } from '../src/webmcp.js';

test('criterion weights normalize to one', () => {
  const workspace = getExample('launch');
  const weights = normalizedWeights(workspace);
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.equal(Number(weights['criterion-learning'].toFixed(2)), 0.30);
});

test('launch example produces a stable base-case ranking', () => {
  const ranking = rankOptions(getExample('launch'));
  assert.equal(ranking.length, 3);
  assert.equal(ranking[0].optionId, 'launch-design-partners');
  assert.ok(ranking[0].score > ranking[1].score);
  assert.ok(ranking.every((item) => item.score >= 0 && item.score <= 10));
});

test('scenario overrides change effective values without mutating base scores', () => {
  const workspace = getExample('launch');
  const base = effectiveCell(workspace, 'launch-self-serve', 'criterion-reach', 'base');
  const scenario = effectiveCell(workspace, 'launch-self-serve', 'criterion-reach', 'scenario-budget-cut');
  assert.equal(base.score, 7.8);
  assert.equal(scenario.score, 6.2);
  assert.equal(workspace.scores['launch-self-serve']['criterion-reach'].score, 7.8);
});

test('re-scoring without evidence keeps the human-authored base evidence', () => {
  const workspace = getExample('launch');
  const before = workspace.scores['launch-self-serve']['criterion-reach'].evidence;
  assert.ok(before.length > 0);

  setScoreCell(workspace, { optionId: 'launch-self-serve', criterionId: 'criterion-reach', score: 6, confidence: 70 });
  const cell = normalizeWorkspace(workspace).scores['launch-self-serve']['criterion-reach'];
  assert.equal(cell.score, 6);
  assert.equal(cell.confidence, 70);
  assert.equal(cell.evidence, before);

  setScoreCell(workspace, { optionId: 'launch-self-serve', criterionId: 'criterion-reach', score: 6, confidence: 70, evidence: 'Replaced.' });
  assert.equal(workspace.scores['launch-self-serve']['criterion-reach'].evidence, 'Replaced.');
});

test('scenario re-scoring without evidence stays sparse and creates no false evidence gap', () => {
  const workspace = getExample('launch');
  const scenarioId = 'scenario-competitor';
  const target = { optionId: 'launch-marketplace', criterionId: 'criterion-reach' };
  const baseEvidence = workspace.scores[target.optionId][target.criterionId].evidence;

  setScoreCell(workspace, { ...target, score: 9.5, confidence: 80, scenarioId });
  const hydrated = normalizeWorkspace(workspace);
  const override = hydrated.scenarios.find((item) => item.id === scenarioId).scoreOverrides[target.optionId][target.criterionId];
  assert.deepEqual(override, { score: 9.5, confidence: 80 });
  assert.equal(effectiveCell(hydrated, target.optionId, target.criterionId, scenarioId).evidence, baseEvidence);
  assert.ok(!findEvidenceGaps(hydrated, scenarioId).some((gap) => (
    gap.optionId === target.optionId && gap.criterionId === target.criterionId && gap.reasons.includes('missing evidence')
  )));

  assert.throws(() => setScoreCell(workspace, { ...target, score: 1, confidence: 1, scenarioId: 'missing' }), /Unknown scenario id/);
});

test('evidence gaps include low-confidence cells and are ordered by confidence', () => {
  const gaps = findEvidenceGaps(getExample('launch'));
  assert.ok(gaps.length > 0);
  assert.equal(gaps[0].confidence, Math.min(...gaps.map((gap) => gap.confidence)));
  assert.ok(gaps.some((gap) => gap.reasons.includes('low confidence')));
});

test('evidence gaps follow the active scenario shown to human and agent', () => {
  const workspace = getExample('launch');
  workspace.activeScenarioId = 'scenario-budget-cut';
  workspace.scenarios.find((scenario) => scenario.id === 'scenario-budget-cut')
    .scoreOverrides['launch-design-partners'] = {
      'criterion-learning': { score: 4, confidence: 10, evidence: '' },
    };
  const active = findEvidenceGaps(workspace);
  const base = findEvidenceGaps(workspace, 'base');
  assert.ok(active.some((gap) => gap.optionId === 'launch-design-partners' && gap.criterionId === 'criterion-learning'));
  assert.ok(!base.some((gap) => gap.optionId === 'launch-design-partners' && gap.criterionId === 'criterion-learning'));
});

test('workspace summary includes the visible activity trail', () => {
  const workspace = getExample('launch');
  const summary = summarizeWorkspace(workspace);
  assert.deepEqual(summary.latestActivity, {
    id: workspace.activity[0].id,
    actor: workspace.activity[0].actor,
    at: workspace.activity[0].at,
  });
  assert.equal(summary.counts.options, workspace.options.length);
});

test('stress test is deterministic for a fixed seed', async () => {
  const workspace = getExample('launch');
  const first = await runStressTest(workspace, { iterations: 500, seed: 42 });
  const second = await runStressTest(workspace, { iterations: 500, seed: 42 });
  assert.deepEqual(first.results, second.results);
  const winRateTotal = first.results.reduce((sum, result) => sum + result.winRate, 0);
  assert.ok(Math.abs(winRateTotal - 100) <= 0.2);
});

test('stress test yields between chunks and observes cancellation', async () => {
  const controller = new AbortController();
  const running = runStressTest(getExample('launch'), {
    iterations: 10000,
    seed: 42,
    chunkSize: 10,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new DOMException('Cancelled by test', 'AbortError')), 0);
  await assert.rejects(running, (error) => error?.name === 'AbortError');
});

test('stress results carry a fingerprint that goes stale only when their inputs change', async () => {
  const workspace = getExample('launch');
  const result = await runStressTest(workspace, { iterations: 200, seed: 7, scenarioId: 'scenario-budget-cut' });
  assert.equal(result.scenarioId, 'scenario-budget-cut');
  assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  workspace.lastStressTest = result;
  assert.equal(isStressTestStale(workspace), false);

  workspace.brief.title = 'Unrelated edit';
  workspace.activeScenarioId = 'scenario-competitor';
  assert.equal(isStressTestStale(workspace), false, 'brief edits and switching the visible scenario do not invalidate the run');

  const hydrated = normalizeWorkspace(workspace);
  assert.equal(hydrated.lastStressTest.fingerprint, result.fingerprint);
  assert.equal(isStressTestStale(hydrated), false);

  setScoreCell(workspace, { optionId: 'launch-design-partners', criterionId: 'criterion-load', score: 2, confidence: 90 });
  assert.equal(isStressTestStale(workspace), true, 'a base score used by the scenario changes the result');

  const weights = getExample('launch');
  weights.lastStressTest = await runStressTest(weights, { iterations: 200, seed: 7 });
  weights.criteria[0].weight = 99;
  assert.equal(isStressTestStale(weights), true);

  const legacy = getExample('launch');
  legacy.lastStressTest = { ...(await runStressTest(legacy, { iterations: 200, seed: 7 })), fingerprint: undefined };
  assert.equal(isStressTestStale(legacy), true, 'results saved before fingerprints exist are treated as stale');
  assert.equal(stressFingerprint(getExample('launch')), stressFingerprint(getExample('launch')));
});

test('markdown export contains visible decision artifacts', () => {
  const markdown = exportMarkdown(getExample('launch'));
  assert.match(markdown, /# Launch Atlas Notes/);
  assert.match(markdown, /## Ranked options/);
  assert.match(markdown, /## Evidence matrix/);
  assert.match(markdown, /## Assumptions/);
});

test('markdown export neutralizes line breaks in single-line fields', () => {
  const workspace = getExample('launch');
  workspace.brief.title = 'Title\n# Injected heading';
  workspace.options[0].name = 'Option\n\n## Injected section';
  workspace.criteria[0].name = 'Criterion\n- injected bullet';
  workspace.scores[workspace.options[0].id][workspace.criteria[0].id].evidence = 'Evidence line one\nEvidence line two';
  workspace.assumptions[0].text = 'Assumption\n# Not a heading';
  workspace.stagedRecommendation = { optionId: workspace.options[0].id, rationale: 'Fine.', actor: 'agent', stagedAt: new Date().toISOString() };
  const markdown = exportMarkdown(workspace);
  const lines = markdown.split('\n');
  assert.ok(!lines.includes('# Injected heading'));
  assert.ok(!lines.includes('## Injected section'));
  assert.ok(!lines.includes('- injected bullet'));
  assert.ok(!lines.includes('Evidence line two'));
  assert.ok(!lines.includes('# Not a heading'));
  assert.ok(lines.includes('# Title # Injected heading'));
  assert.ok(lines.includes('### Option ## Injected section'));
  assert.ok(lines.includes('**Option ## Injected section**'));
  assert.ok(lines.some((line) => line.startsWith('- **Criterion - injected bullet:**') && line.includes('Evidence line one Evidence line two')));
});

test('markdown export stamps the latest activity time and never falls back to the epoch', () => {
  const stamped = getExample('launch');
  stamped.activity = [{ id: 'activity-1', at: '2026-08-28T10:00:00.000Z', actor: 'human', text: 'Edited.' }];
  assert.match(exportMarkdown(stamped), /snapshot 2026-08-28T10:00:00\.000Z\./);

  const empty = getExample('launch');
  empty.activity = [];
  const before = Date.now() - 1000;
  const footer = exportMarkdown(empty).match(/snapshot (\S+)\.$/)[1];
  assert.ok(!footer.startsWith('1970'));
  assert.ok(Date.parse(footer) >= before);
});

test('corrupt numeric cells fall back to neutral defaults instead of clamping to zero', () => {
  const workspace = normalizeWorkspace({
    ...getExample('launch'),
    scores: {
      'launch-self-serve': {
        'criterion-learning': { score: 'abc', confidence: null, evidence: 'kept' },
        'criterion-reach': { score: '7.5', confidence: '250', evidence: '' },
        'criterion-load': { score: Infinity, confidence: -5 },
      },
    },
  }, getExample('launch'));
  const cells = workspace.scores['launch-self-serve'];
  assert.deepEqual(cells['criterion-learning'], { score: 5, confidence: 40, evidence: 'kept' });
  assert.deepEqual(cells['criterion-reach'], { score: 7.5, confidence: 100, evidence: '' });
  assert.deepEqual(cells['criterion-load'], { score: 5, confidence: 0, evidence: '' });
});

test('prototype-like ids are refused by hydration and by the tool id schema', () => {
  const workspace = normalizeWorkspace({
    ...getExample('launch'),
    options: [
      { id: 'constructor', name: 'Constructor' },
      { id: '__proto__', name: 'Proto' },
      { id: 'prototype', name: 'Prototype' },
      { id: 'safe-id', name: 'Safe' },
    ],
  }, getExample('launch'));
  assert.deepEqual(workspace.options.map((item) => item.id), ['option-1', 'option-2', 'option-3', 'safe-id']);
  assert.equal(Object.getPrototypeOf(workspace.scores), Object.prototype);
  assert.ok(!Object.hasOwn(workspace.scores, 'constructor'));

  for (const bad of ['constructor', '__proto__', 'prototype']) {
    assert.throws(() => validateInput(schemas.id, bad), /invalid format/, bad);
  }
  assert.equal(validateInput(schemas.id, 'constructor-2'), true);
  assert.equal(validateInput(schemas.id, 'option-a1_b'), true);
});

test('workspace hydration normalizes versions, structure, text, and collection limits', () => {
  const fallback = getExample('launch');
  const oversized = {
    version: 0,
    brief: { title: 'x'.repeat(500), question: 42, context: 'c'.repeat(5000) },
    options: Array.from({ length: 40 }, (_, index) => ({
      id: index === 1 ? 'duplicate' : index === 2 ? 'duplicate' : `bad id ${index}`,
      name: `Option ${index}`,
      description: 'o'.repeat(2000),
    })),
    criteria: Array.from({ length: 30 }, (_, index) => ({
      id: `criterion-${index}`,
      name: `Criterion ${index}`,
      description: 'd'.repeat(2000),
      weight: 500,
    })),
    assumptions: Array.from({ length: 60 }, (_, index) => ({ id: `assumption-${index}`, text: 'a'.repeat(2000) })),
    scenarios: Array.from({ length: 20 }, (_, index) => ({ id: `scenario-${index}`, name: `Scenario ${index}` })),
    activity: Array.from({ length: 80 }, (_, index) => ({ id: `activity-${index}`, text: 'z'.repeat(500) })),
    activeScenarioId: 'missing',
  };
  const hydrated = normalizeWorkspace(oversized, fallback);
  assert.equal(hydrated.version, 1);
  assert.equal(hydrated.options.length, WORKSPACE_LIMITS.options);
  assert.equal(hydrated.criteria.length, WORKSPACE_LIMITS.criteria);
  assert.equal(hydrated.assumptions.length, WORKSPACE_LIMITS.assumptions);
  assert.equal(hydrated.scenarios.length, WORKSPACE_LIMITS.scenarios);
  assert.equal(hydrated.activity.length, WORKSPACE_LIMITS.activity);
  assert.equal(hydrated.brief.title.length, WORKSPACE_LIMITS.title);
  assert.equal(hydrated.brief.context.length, WORKSPACE_LIMITS.context);
  assert.equal(hydrated.brief.question, 'What are we deciding?');
  assert.equal(hydrated.activeScenarioId, 'base');
  assert.equal(new Set(hydrated.options.map((item) => item.id)).size, hydrated.options.length);
  assert.ok(hydrated.options.every((item) => item.description.length <= WORKSPACE_LIMITS.optionDescription));
  assert.ok(hydrated.criteria.every((item) => item.weight <= 100));

  const future = normalizeWorkspace({ version: 99, options: [{ id: 'future', name: 'Future' }] }, fallback);
  assert.equal(future.brief.title, fallback.brief.title);
});

test('workspace reads are bounded and every collection is recoverable by cursor', () => {
  const hostile = '\\'.repeat;
  const options = Array.from({ length: WORKSPACE_LIMITS.options }, (_, index) => ({
    id: `option-${index}`,
    name: hostile.call('\\', WORKSPACE_LIMITS.name),
    description: hostile.call('\\', WORKSPACE_LIMITS.optionDescription),
  }));
  const criteria = Array.from({ length: WORKSPACE_LIMITS.criteria }, (_, index) => ({
    id: `criterion-${index}`,
    name: hostile.call('\\', WORKSPACE_LIMITS.name),
    description: hostile.call('\\', WORKSPACE_LIMITS.criterionDescription),
    weight: 10,
  }));
  const scores = Object.fromEntries(options.map((option) => [option.id, Object.fromEntries(criteria.map((criterion) => [
    criterion.id,
    { score: 5, confidence: 50, evidence: hostile.call('\\', WORKSPACE_LIMITS.evidence) },
  ]))]));
  const workspace = normalizeWorkspace({
    ...getExample('launch'),
    brief: {
      title: hostile.call('\\', WORKSPACE_LIMITS.title),
      question: hostile.call('\\', WORKSPACE_LIMITS.question),
      context: hostile.call('\\', WORKSPACE_LIMITS.context),
      constraints: hostile.call('\\', WORKSPACE_LIMITS.constraints),
    },
    options,
    criteria,
    scores,
    assumptions: Array.from({ length: WORKSPACE_LIMITS.assumptions }, (_, index) => ({
      id: `assumption-${index}`,
      text: hostile.call('\\', WORKSPACE_LIMITS.assumption),
      impact: 'high',
      status: 'open',
    })),
    scenarios: Array.from({ length: WORKSPACE_LIMITS.scenarios }, (_, index) => ({
      id: `scenario-${index}`,
      name: hostile.call('\\', WORKSPACE_LIMITS.name),
      description: hostile.call('\\', WORKSPACE_LIMITS.description),
      weightOverrides: {},
      scoreOverrides: index === 0 ? {
        'option-0': { 'criterion-0': { score: 5, confidence: 50, evidence: hostile.call('\\', WORKSPACE_LIMITS.evidence) } },
      } : {},
    })),
    stagedRecommendation: {
      optionId: 'option-0',
      rationale: hostile.call('\\', WORKSPACE_LIMITS.rationale),
      actor: 'agent',
      stagedAt: new Date().toISOString(),
    },
  }, getExample('launch'));

  for (const section of WORKSPACE_READ_SECTIONS) {
    let cursor = 0;
    let seen = 0;
    do {
      const result = readWorkspacePage(workspace, { section, cursor, pageSize: 999 });
      assert.ok(JSON.stringify(result).length <= TOOL_RESULT_LIMITS.serializedChars, `${section} exceeded result budget`);
      assert.equal(result.scenarioId, 'base');
      if (section === 'overview') {
        assert.ok(JSON.stringify(result).length <= TOOL_RESULT_LIMITS.defaultReadChars, 'overview exceeded default read budget');
        assert.equal(result.ranking.length, WORKSPACE_LIMITS.options);
        assert.equal(result.criteria.length, WORKSPACE_LIMITS.criteria);
        break;
      }
      assert.ok(result.page.pageSize <= TOOL_RESULT_LIMITS.pageSize);
      assert.ok(result.items.length >= 1 || result.page.total === 0);
      seen += result.items.length;
      cursor = result.page.nextCursor;
      if (cursor === null) {
        assert.equal(seen, result.page.total);
        break;
      }
      assert.equal(cursor, seen);
    } while (true);
  }

  const gaps = findEvidenceGapsPage(workspace, { pageSize: 999 });
  assert.ok(gaps.items.length <= TOOL_RESULT_LIMITS.pageSize);
  assert.ok(JSON.stringify(gaps).length <= TOOL_RESULT_LIMITS.serializedChars);
});

test('overview carries the complete ranking and criteria weights; sections page independently', () => {
  const workspace = getExample('launch');
  workspace.activeScenarioId = 'scenario-budget-cut';
  const overview = readWorkspacePage(workspace);
  assert.equal(overview.section, 'overview');
  assert.equal(overview.scenarioId, 'scenario-budget-cut');
  assert.deepEqual(
    overview.ranking.map((item) => item.optionId),
    rankOptions(workspace).map((item) => item.optionId),
  );
  assert.ok(overview.ranking.every((item) => ['optionId', 'option', 'score', 'confidence'].every((key) => key in item)));
  assert.ok(overview.criteria.every((item) => ['id', 'name', 'normalizedWeight'].every((key) => key in item)));
  assert.ok(Math.abs(overview.criteria.reduce((sum, item) => sum + item.normalizedWeight, 0) - 1) < 1e-3);

  const matrix = readWorkspacePage(workspace, { section: 'matrix' });
  assert.equal(matrix.page.pageSize, TOOL_RESULT_LIMITS.defaultPageSize);
  assert.equal(matrix.items.length, TOOL_RESULT_LIMITS.defaultPageSize);
  assert.equal(matrix.page.total, workspace.options.length * workspace.criteria.length);
  assert.equal(matrix.page.nextCursor, TOOL_RESULT_LIMITS.defaultPageSize);
  assert.deepEqual(Object.keys(matrix.items[0]).sort(), ['confidence', 'criterionId', 'hasEvidence', 'optionId', 'score']);
  assert.equal(matrix.scenarioId, 'scenario-budget-cut');
  const override = matrix.items.find((item) => item.optionId === 'launch-self-serve' && item.criterionId === 'criterion-reach');
  assert.equal(override.score, 6.2);

  const criteria = readWorkspacePage(workspace, { section: 'criteria', pageSize: 999 });
  assert.equal(criteria.page.pageSize, TOOL_RESULT_LIMITS.pageSize);
  const load = criteria.items.find((item) => item.id === 'criterion-load');
  assert.equal(load.weight, 25);
  assert.equal(load.effectiveWeight, 42);

  const activity = readWorkspacePage(workspace, { section: 'activity' });
  assert.equal(activity.page.nextCursor, null);
});

test('oversized pages shrink to the serialized budget instead of failing', () => {
  const workspace = normalizeWorkspace({
    ...getExample('launch'),
    options: Array.from({ length: 12 }, (_, index) => ({ id: `option-${index}`, name: `Option ${index}` })),
    criteria: Array.from({ length: 4 }, (_, index) => ({ id: `criterion-${index}`, name: `Criterion ${index}`, weight: 25 })),
    scores: Object.fromEntries(Array.from({ length: 12 }, (_, option) => [`option-${option}`, Object.fromEntries(Array.from({ length: 4 }, (_, criterion) => [
      `criterion-${criterion}`,
      { score: 5, confidence: 50, evidence: '\\'.repeat(WORKSPACE_LIMITS.evidence) },
    ]))])),
  }, getExample('launch'));
  const result = readWorkspacePage(workspace, { section: 'evidence', pageSize: TOOL_RESULT_LIMITS.pageSize });
  assert.ok(result.items.length < TOOL_RESULT_LIMITS.pageSize);
  assert.equal(result.page.returned, result.items.length);
  assert.equal(result.page.nextCursor, result.items.length);
  assert.ok(JSON.stringify(result).length <= TOOL_RESULT_LIMITS.serializedChars);
});

test('Markdown tool export is capped and reconstructable page by page', () => {
  const workspace = getExample('launch');
  const expected = exportMarkdown(workspace);
  let cursor = 0;
  let reconstructed = '';
  do {
    const result = exportMarkdownPage(workspace, { cursor, maxChars: 999999 });
    assert.ok(result.markdown.length <= TOOL_RESULT_LIMITS.exportChars);
    assert.ok(JSON.stringify(result).length <= TOOL_RESULT_LIMITS.serializedChars);
    reconstructed += result.markdown;
    cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(reconstructed, expected);
});
