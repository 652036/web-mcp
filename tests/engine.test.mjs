import test from 'node:test';
import assert from 'node:assert/strict';
import { getExample } from '../src/data.js';
import {
  effectiveCell,
  exportMarkdown,
  findEvidenceGaps,
  normalizedWeights,
  rankOptions,
  runStressTest,
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

test('stress test is deterministic for a fixed seed', () => {
  const workspace = getExample('launch');
  const first = runStressTest(workspace, { iterations: 500, seed: 42 });
  const second = runStressTest(workspace, { iterations: 500, seed: 42 });
  assert.deepEqual(first.results, second.results);
  const winRateTotal = first.results.reduce((sum, result) => sum + result.winRate, 0);
  assert.ok(Math.abs(winRateTotal - 100) <= 0.2);
});

test('markdown export contains visible decision artifacts', () => {
  const markdown = exportMarkdown(getExample('launch'));
  assert.match(markdown, /# Launch Atlas Notes/);
  assert.match(markdown, /## Ranked options/);
  assert.match(markdown, /## Evidence matrix/);
  assert.match(markdown, /## Assumptions/);
});
