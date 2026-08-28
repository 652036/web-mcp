const DEFAULT_SCORE = 5;
const DEFAULT_CONFIDENCE = 50;

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function makeId(prefix = 'item') {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

export function getScenario(state, scenarioId = state.activeScenarioId) {
  if (!scenarioId || scenarioId === 'base') return null;
  return state.scenarios.find((scenario) => scenario.id === scenarioId) ?? null;
}

export function normalizedWeights(state, scenarioId = state.activeScenarioId) {
  const scenario = getScenario(state, scenarioId);
  const raw = state.criteria.map((criterion) => {
    const override = scenario?.weightOverrides?.[criterion.id];
    const weight = override ?? criterion.weight ?? 0;
    return Math.max(0, Number(weight) || 0);
  });
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  if (!raw.length) return {};
  const fallback = 1 / raw.length;
  return Object.fromEntries(state.criteria.map((criterion, index) => [
    criterion.id,
    total > 0 ? raw[index] / total : fallback,
  ]));
}

export function effectiveCell(state, optionId, criterionId, scenarioId = state.activeScenarioId) {
  const base = state.scores?.[optionId]?.[criterionId] ?? {};
  const scenario = getScenario(state, scenarioId);
  const override = scenario?.scoreOverrides?.[optionId]?.[criterionId] ?? {};
  return {
    score: clamp(override.score ?? base.score ?? DEFAULT_SCORE, 0, 10),
    confidence: clamp(override.confidence ?? base.confidence ?? DEFAULT_CONFIDENCE, 0, 100),
    evidence: String(override.evidence ?? base.evidence ?? '').trim(),
  };
}

export function rankOptions(state, scenarioId = state.activeScenarioId) {
  if (!state.options.length || !state.criteria.length) return [];
  const weights = normalizedWeights(state, scenarioId);
  return state.options
    .map((option) => {
      let score = 0;
      let confidence = 0;
      const contributions = state.criteria.map((criterion) => {
        const cell = effectiveCell(state, option.id, criterion.id, scenarioId);
        const weight = weights[criterion.id] ?? 0;
        const contribution = cell.score * weight;
        score += contribution;
        confidence += cell.confidence * weight;
        return {
          criterionId: criterion.id,
          criterion: criterion.name,
          score: cell.score,
          confidence: cell.confidence,
          weight,
          contribution,
        };
      });
      return {
        optionId: option.id,
        option: option.name,
        description: option.description,
        score: Number(score.toFixed(3)),
        confidence: Number(confidence.toFixed(1)),
        contributions,
      };
    })
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.option.localeCompare(b.option));
}

export function findEvidenceGaps(state) {
  const gaps = [];
  for (const option of state.options) {
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id, 'base');
      const reasons = [];
      if (!cell.evidence) reasons.push('missing evidence');
      if (cell.confidence < 55) reasons.push('low confidence');
      if (reasons.length) {
        gaps.push({
          optionId: option.id,
          option: option.name,
          criterionId: criterion.id,
          criterion: criterion.name,
          score: cell.score,
          confidence: cell.confidence,
          reasons,
        });
      }
    }
  }
  return gaps.sort((a, b) => a.confidence - b.confidence || a.option.localeCompare(b.option));
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random) {
  const u = Math.max(Number.EPSILON, random());
  const v = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(sorted, percentile) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function runStressTest(state, {
  iterations = 1000,
  seed = 20260828,
  weightVolatility = 0.18,
  scoreVolatility = 1.25,
  scenarioId = state.activeScenarioId,
} = {}) {
  const safeIterations = Math.round(clamp(iterations, 100, 10000));
  const random = mulberry32(Number(seed) || 1);
  const baseWeights = normalizedWeights(state, scenarioId);
  const results = Object.fromEntries(state.options.map((option) => [option.id, {
    optionId: option.id,
    option: option.name,
    wins: 0,
    scores: [],
  }]));

  if (!state.options.length || !state.criteria.length) {
    return { iterations: safeIterations, seed, scenarioId, results: [] };
  }

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const perturbedWeights = {};
    let totalWeight = 0;
    for (const criterion of state.criteria) {
      const base = baseWeights[criterion.id] ?? 0;
      const perturbed = Math.max(0.001, base * (1 + normal(random) * weightVolatility));
      perturbedWeights[criterion.id] = perturbed;
      totalWeight += perturbed;
    }
    for (const criterion of state.criteria) {
      perturbedWeights[criterion.id] /= totalWeight;
    }

    let bestId = null;
    let bestScore = -Infinity;
    for (const option of state.options) {
      let total = 0;
      for (const criterion of state.criteria) {
        const cell = effectiveCell(state, option.id, criterion.id, scenarioId);
        const uncertainty = (1 - cell.confidence / 100) * scoreVolatility;
        const simulatedScore = clamp(cell.score + normal(random) * uncertainty, 0, 10);
        total += simulatedScore * perturbedWeights[criterion.id];
      }
      results[option.id].scores.push(total);
      if (total > bestScore) {
        bestScore = total;
        bestId = option.id;
      }
    }
    results[bestId].wins += 1;
  }

  const summary = Object.values(results).map((result) => {
    const sorted = [...result.scores].sort((a, b) => a - b);
    const expected = sorted.reduce((sum, score) => sum + score, 0) / sorted.length;
    return {
      optionId: result.optionId,
      option: result.option,
      winRate: Number(((result.wins / safeIterations) * 100).toFixed(1)),
      expectedScore: Number(expected.toFixed(2)),
      p10: Number(quantile(sorted, 0.1).toFixed(2)),
      p90: Number(quantile(sorted, 0.9).toFixed(2)),
    };
  }).sort((a, b) => b.winRate - a.winRate || b.expectedScore - a.expectedScore);

  return {
    iterations: safeIterations,
    seed: Number(seed) || 1,
    scenarioId: scenarioId || 'base',
    generatedAt: new Date().toISOString(),
    results: summary,
  };
}

export function summarizeWorkspace(state) {
  const ranking = rankOptions(state);
  const activeScenario = getScenario(state);
  return {
    brief: deepClone(state.brief),
    status: state.committedDecision ? 'committed' : state.stagedRecommendation ? 'awaiting-human-review' : 'in-progress',
    activeScenario: activeScenario ? { id: activeScenario.id, name: activeScenario.name } : { id: 'base', name: 'Base case' },
    options: deepClone(state.options),
    criteria: state.criteria.map((criterion) => ({
      ...deepClone(criterion),
      normalizedWeight: normalizedWeights(state)[criterion.id] ?? 0,
    })),
    ranking,
    evidenceGaps: findEvidenceGaps(state),
    assumptions: deepClone(state.assumptions),
    scenarios: deepClone(state.scenarios),
    stagedRecommendation: deepClone(state.stagedRecommendation),
    committedDecision: deepClone(state.committedDecision),
    lastStressTest: deepClone(state.lastStressTest),
  };
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function exportMarkdown(state) {
  const ranking = rankOptions(state);
  const scenario = getScenario(state);
  const lines = [
    `# ${state.brief.title || 'Untitled decision'}`,
    '',
    `**Question:** ${state.brief.question || 'Not defined'}`,
    '',
    `**Active scenario:** ${scenario?.name ?? 'Base case'}`,
    '',
  ];

  if (state.brief.context) lines.push('## Context', '', state.brief.context, '');
  if (state.brief.constraints) lines.push('## Constraints', '', state.brief.constraints, '');

  lines.push('## Ranked options', '', '| Rank | Option | Score | Confidence |', '| ---: | --- | ---: | ---: |');
  ranking.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${escapeTable(item.option)} | ${item.score.toFixed(2)} | ${item.confidence.toFixed(0)}% |`);
  });
  lines.push('', '## Criteria', '', '| Criterion | Weight | Description |', '| --- | ---: | --- |');
  const weights = normalizedWeights(state);
  state.criteria.forEach((criterion) => {
    lines.push(`| ${escapeTable(criterion.name)} | ${((weights[criterion.id] ?? 0) * 100).toFixed(0)}% | ${escapeTable(criterion.description)} |`);
  });

  lines.push('', '## Evidence matrix', '');
  for (const option of state.options) {
    lines.push(`### ${option.name}`, '');
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id);
      lines.push(`- **${criterion.name}:** ${cell.score.toFixed(1)}/10, ${cell.confidence.toFixed(0)}% confidence${cell.evidence ? ` — ${cell.evidence}` : ' — evidence not recorded'}`);
    }
    lines.push('');
  }

  lines.push('## Assumptions', '');
  if (state.assumptions.length) {
    state.assumptions.forEach((assumption) => lines.push(`- [${assumption.status === 'validated' ? 'x' : ' '}] ${assumption.text} (${assumption.impact} impact)`));
  } else {
    lines.push('- No assumptions recorded.');
  }
  lines.push('');

  if (state.stagedRecommendation) {
    const option = state.options.find((item) => item.id === state.stagedRecommendation.optionId);
    lines.push('## Staged recommendation', '', `**${option?.name ?? 'Unknown option'}**`, '', state.stagedRecommendation.rationale, '');
  }
  if (state.committedDecision) {
    const option = state.options.find((item) => item.id === state.committedDecision.optionId);
    lines.push('## Human-committed decision', '', `**${option?.name ?? 'Unknown option'}**`, '', state.committedDecision.note || '', '', `Committed at ${state.committedDecision.committedAt}.`, '');
  }

  lines.push('---', '', `Exported from Forkcast on ${new Date().toISOString()}.`);
  return lines.join('\n');
}
