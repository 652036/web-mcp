import test from 'node:test';
import assert from 'node:assert/strict';
import { getExample } from '../src/data.js';
import {
  effectiveCell,
  exportMarkdown,
  exportMarkdownPage,
  findEvidenceGaps,
  normalizeWorkspace,
  normalizedWeights,
  rankOptions,
  readWorkspacePage,
  runStressTest,
  summarizeWorkspace,
  TOOL_RESULT_LIMITS,
  WORKSPACE_LIMITS,
  WORKSPACE_READ_SECTIONS,
} from '../src/engine.js';

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

test('markdown export contains visible decision artifacts', () => {
  const markdown = exportMarkdown(getExample('launch'));
  assert.match(markdown, /# Launch Atlas Notes/);
  assert.match(markdown, /## Ranked options/);
  assert.match(markdown, /## Evidence matrix/);
  assert.match(markdown, /## Assumptions/);
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
      if (section === 'overview') assert.ok(JSON.stringify(result).length <= TOOL_RESULT_LIMITS.defaultReadChars);
      if (section === 'overview') break;
      seen += result.items.length;
      cursor = result.page.nextCursor;
      if (cursor === null) {
        assert.equal(seen, result.page.total);
        break;
      }
    } while (true);
  }
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
