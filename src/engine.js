const DEFAULT_SCORE = 5;
const DEFAULT_CONFIDENCE = 50;

export const WORKSPACE_VERSION = 1;
export const WORKSPACE_LIMITS = Object.freeze({
  options: 24,
  criteria: 16,
  assumptions: 40,
  scenarios: 12,
  activity: 60,
  id: 120,
  title: 120,
  question: 300,
  context: 4000,
  constraints: 4000,
  name: 160,
  description: 2000,
  optionDescription: 1000,
  criterionDescription: 1000,
  evidence: 2000,
  assumption: 1000,
  rationale: 4000,
  activityText: 300,
});

export const TOOL_RESULT_LIMITS = Object.freeze({
  pageSize: 25,
  defaultPageSize: 8,
  exportChars: 6000,
  defaultExportChars: 4000,
  textFragmentChars: 700,
  serializedChars: 12000,
  defaultReadChars: 10000,
  overviewLabelChars: 60,
});

/** Ids double as object keys in score maps, so prototype-ish names are refused. */
export const ID_PATTERN_SOURCE = '^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9][A-Za-z0-9_-]*$';
const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maximum);
}

function normalizedId(value, fallback, used) {
  const candidate = boundedText(value, WORKSPACE_LIMITS.id);
  const base = ID_PATTERN.test(candidate) ? candidate : fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix}`;
    id = `${base.slice(0, WORKSPACE_LIMITS.id - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function normalizedTimestamp(value, fallback = new Date(0).toISOString()) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

/** Clamp a finite number; anything unparseable becomes the neutral default, not the minimum. */
function boundedNumber(value, min, max, fallback) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

function normalizedCell(value, { sparse = false } = {}) {
  if (!isRecord(value)) return sparse ? null : { score: DEFAULT_SCORE, confidence: 40, evidence: '' };
  const cell = {};
  if (!sparse || value.score !== undefined) cell.score = boundedNumber(value.score, 0, 10, DEFAULT_SCORE);
  if (!sparse || value.confidence !== undefined) cell.confidence = boundedNumber(value.confidence, 0, 100, 40);
  if (!sparse || value.evidence !== undefined) cell.evidence = boundedText(value.evidence, WORKSPACE_LIMITS.evidence);
  return Object.keys(cell).length ? cell : null;
}

function normalizeRecommendation(value, optionIds, { committed = false } = {}) {
  if (!isRecord(value) || !optionIds.has(value.optionId)) return null;
  if (committed) {
    return {
      optionId: value.optionId,
      note: boundedText(value.note, WORKSPACE_LIMITS.rationale),
      committedAt: normalizedTimestamp(value.committedAt),
    };
  }
  const actor = value.actor === 'human' ? 'human' : 'agent';
  return {
    optionId: value.optionId,
    rationale: boundedText(value.rationale, WORKSPACE_LIMITS.rationale),
    stagedAt: normalizedTimestamp(value.stagedAt),
    actor,
  };
}

/**
 * Hydrate untrusted persisted JSON into the current bounded workspace shape.
 * Unknown future versions fall back rather than being interpreted as v1.
 */
export function normalizeWorkspace(value, fallback = null) {
  const fallbackSource = isRecord(fallback) ? fallback : {};
  const incoming = isRecord(value) ? value : fallbackSource;
  const source = Number(incoming.version) > WORKSPACE_VERSION ? fallbackSource : incoming;
  const fallbackBrief = isRecord(fallbackSource.brief) ? fallbackSource.brief : {};
  const sourceBrief = isRecord(source.brief) ? source.brief : fallbackBrief;

  const optionSource = Array.isArray(source.options) && source.options.length
    ? source.options
    : Array.isArray(fallbackSource.options) ? fallbackSource.options : [];
  const optionIds = new Set();
  const options = optionSource.slice(0, WORKSPACE_LIMITS.options).map((item, index) => {
    const record = isRecord(item) ? item : {};
    return {
      id: normalizedId(record.id, `option-${index + 1}`, optionIds),
      name: boundedText(record.name, WORKSPACE_LIMITS.name, `Option ${index + 1}`) || `Option ${index + 1}`,
      description: boundedText(record.description, WORKSPACE_LIMITS.optionDescription),
    };
  });

  const criterionSource = Array.isArray(source.criteria) && source.criteria.length
    ? source.criteria
    : Array.isArray(fallbackSource.criteria) ? fallbackSource.criteria : [];
  const criterionIds = new Set();
  const criteria = criterionSource.slice(0, WORKSPACE_LIMITS.criteria).map((item, index) => {
    const record = isRecord(item) ? item : {};
    return {
      id: normalizedId(record.id, `criterion-${index + 1}`, criterionIds),
      name: boundedText(record.name, WORKSPACE_LIMITS.name, `Criterion ${index + 1}`) || `Criterion ${index + 1}`,
      description: boundedText(record.description, WORKSPACE_LIMITS.criterionDescription),
      weight: clamp(record.weight ?? 0, 0, 100),
    };
  });

  const rawScores = isRecord(source.scores) ? source.scores : {};
  const scores = Object.fromEntries(options.map((option) => [
    option.id,
    Object.fromEntries(criteria.map((criterion) => [
      criterion.id,
      normalizedCell(rawScores[option.id]?.[criterion.id]),
    ])),
  ]));

  const assumptionIds = new Set();
  const assumptions = (Array.isArray(source.assumptions) ? source.assumptions : [])
    .slice(0, WORKSPACE_LIMITS.assumptions)
    .map((item, index) => {
      const record = isRecord(item) ? item : {};
      return {
        id: normalizedId(record.id, `assumption-${index + 1}`, assumptionIds),
        text: boundedText(record.text, WORKSPACE_LIMITS.assumption, `Assumption ${index + 1}`) || `Assumption ${index + 1}`,
        impact: ['low', 'medium', 'high'].includes(record.impact) ? record.impact : 'medium',
        status: ['open', 'testing', 'validated', 'invalidated'].includes(record.status) ? record.status : 'open',
      };
    });

  const scenarioIds = new Set();
  const scenarios = (Array.isArray(source.scenarios) ? source.scenarios : [])
    .slice(0, WORKSPACE_LIMITS.scenarios)
    .map((item, index) => {
      const record = isRecord(item) ? item : {};
      const id = normalizedId(record.id, `scenario-${index + 1}`, scenarioIds);
      const rawWeights = isRecord(record.weightOverrides) ? record.weightOverrides : {};
      const weightOverrides = Object.fromEntries(criteria
        .filter((criterion) => Object.hasOwn(rawWeights, criterion.id))
        .map((criterion) => [criterion.id, clamp(rawWeights[criterion.id], 0, 100)]));
      const rawOverrides = isRecord(record.scoreOverrides) ? record.scoreOverrides : {};
      const scoreOverrides = {};
      for (const option of options) {
        const rawOption = isRecord(rawOverrides[option.id]) ? rawOverrides[option.id] : {};
        const cells = {};
        for (const criterion of criteria) {
          if (!Object.hasOwn(rawOption, criterion.id)) continue;
          const cell = normalizedCell(rawOption[criterion.id], { sparse: true });
          if (cell) cells[criterion.id] = cell;
        }
        if (Object.keys(cells).length) scoreOverrides[option.id] = cells;
      }
      return {
        id,
        name: boundedText(record.name, WORKSPACE_LIMITS.name, `Scenario ${index + 1}`) || `Scenario ${index + 1}`,
        description: boundedText(record.description, WORKSPACE_LIMITS.description),
        weightOverrides,
        scoreOverrides,
      };
    });

  const allowedActors = new Set(['agent', 'human', 'system']);
  const activityIds = new Set();
  const activity = (Array.isArray(source.activity) ? source.activity : [])
    .slice(0, WORKSPACE_LIMITS.activity)
    .map((item, index) => {
      const record = isRecord(item) ? item : {};
      return {
        id: normalizedId(record.id, `activity-${index + 1}`, activityIds),
        at: normalizedTimestamp(record.at),
        actor: allowedActors.has(record.actor) ? record.actor : 'system',
        text: boundedText(record.text, WORKSPACE_LIMITS.activityText, 'Workspace activity'),
      };
    });

  const rawStress = isRecord(source.lastStressTest) ? source.lastStressTest : null;
  const lastStressTest = rawStress && Array.isArray(rawStress.results) ? {
    iterations: Math.round(clamp(rawStress.iterations, 100, 10000)),
    seed: Math.round(clamp(rawStress.seed, 1, 2147483647)),
    scenarioId: scenarioIds.has(rawStress.scenarioId) ? rawStress.scenarioId : 'base',
    fingerprint: /^[0-9a-f]{8}$/.test(rawStress.fingerprint) ? rawStress.fingerprint : '',
    generatedAt: normalizedTimestamp(rawStress.generatedAt),
    results: rawStress.results.slice(0, options.length).flatMap((item) => {
      const record = isRecord(item) ? item : {};
      if (!optionIds.has(record.optionId)) return [];
      const option = options.find((candidate) => candidate.id === record.optionId);
      return [{
        optionId: record.optionId,
        option: option?.name ?? '',
        winRate: clamp(record.winRate, 0, 100),
        expectedScore: clamp(record.expectedScore, 0, 10),
        p10: clamp(record.p10, 0, 10),
        p90: clamp(record.p90, 0, 10),
      }];
    }),
  } : null;

  const committedDecision = normalizeRecommendation(source.committedDecision, optionIds, { committed: true });
  const stagedRecommendation = committedDecision
    ? null
    : normalizeRecommendation(source.stagedRecommendation, optionIds);

  return {
    version: WORKSPACE_VERSION,
    brief: {
      title: boundedText(sourceBrief.title, WORKSPACE_LIMITS.title, 'Untitled decision') || 'Untitled decision',
      question: boundedText(sourceBrief.question, WORKSPACE_LIMITS.question, 'What are we deciding?') || 'What are we deciding?',
      context: boundedText(sourceBrief.context, WORKSPACE_LIMITS.context),
      constraints: boundedText(sourceBrief.constraints, WORKSPACE_LIMITS.constraints),
    },
    options,
    criteria,
    scores,
    assumptions,
    scenarios,
    activeScenarioId: scenarioIds.has(source.activeScenarioId) ? source.activeScenarioId : 'base',
    stagedRecommendation,
    committedDecision,
    lastStressTest,
    activity,
  };
}

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

/**
 * Write a score cell into the base case or a scenario override layer.
 * Omitting `evidence` keeps the existing base evidence and leaves the scenario
 * override sparse, so a numeric re-score never manufactures an evidence gap.
 */
export function setScoreCell(state, { optionId, criterionId, score, confidence, evidence, scenarioId = 'base' }) {
  const cell = { score, confidence };
  if (evidence !== undefined) cell.evidence = evidence;
  if (!scenarioId || scenarioId === 'base') {
    state.scores[optionId] ??= {};
    const existing = state.scores[optionId][criterionId] ?? {};
    state.scores[optionId][criterionId] = { ...existing, ...cell };
    return state.scores[optionId][criterionId];
  }
  const scenario = state.scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario id: ${scenarioId}`);
  scenario.scoreOverrides ??= {};
  scenario.scoreOverrides[optionId] ??= {};
  const existing = scenario.scoreOverrides[optionId][criterionId] ?? {};
  scenario.scoreOverrides[optionId][criterionId] = { ...existing, ...cell };
  return scenario.scoreOverrides[optionId][criterionId];
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

export function findEvidenceGaps(state, scenarioId = state.activeScenarioId) {
  const gaps = [];
  for (const option of state.options) {
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id, scenarioId);
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? new DOMException('The stress test was aborted.', 'AbortError');
}

function yieldToMain() {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint every input the stress test depends on for a scenario: the
 * option set, normalized weights, and effective score/confidence cells. A
 * saved result whose fingerprint no longer matches is stale.
 */
export function stressFingerprint(state, scenarioId = state.activeScenarioId) {
  const weights = normalizedWeights(state, scenarioId);
  const payload = state.options.map((option) => [
    option.id,
    state.criteria.map((criterion) => {
      const cell = effectiveCell(state, option.id, criterion.id, scenarioId);
      return [criterion.id, Number((weights[criterion.id] ?? 0).toFixed(6)), cell.score, cell.confidence];
    }),
  ]);
  return hashString(JSON.stringify(payload));
}

export async function runStressTest(state, {
  iterations = 1000,
  seed = 20260828,
  weightVolatility = 0.18,
  scoreVolatility = 1.25,
  scenarioId = state.activeScenarioId,
  signal,
  chunkSize = 100,
} = {}) {
  const safeIterations = Math.round(clamp(iterations, 100, 10000));
  const safeChunkSize = Math.round(clamp(chunkSize, 10, 500));
  const safeScenarioId = scenarioId || 'base';
  const random = mulberry32(Number(seed) || 1);
  const baseWeights = normalizedWeights(state, safeScenarioId);
  const fingerprint = stressFingerprint(state, safeScenarioId);
  const results = Object.fromEntries(state.options.map((option) => [option.id, {
    optionId: option.id,
    option: option.name,
    wins: 0,
    scores: [],
  }]));

  if (!state.options.length || !state.criteria.length) {
    return { iterations: safeIterations, seed: Number(seed) || 1, scenarioId: safeScenarioId, fingerprint, generatedAt: new Date().toISOString(), results: [] };
  }

  const cells = state.options.map((option) => state.criteria.map((criterion) => {
    const cell = effectiveCell(state, option.id, criterion.id, safeScenarioId);
    return { score: cell.score, uncertainty: (1 - cell.confidence / 100) * scoreVolatility };
  }));

  throwIfAborted(signal);
  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    throwIfAborted(signal);
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
    state.options.forEach((option, optionIndex) => {
      let total = 0;
      state.criteria.forEach((criterion, criterionIndex) => {
        const cell = cells[optionIndex][criterionIndex];
        const simulatedScore = clamp(cell.score + normal(random) * cell.uncertainty, 0, 10);
        total += simulatedScore * perturbedWeights[criterion.id];
      });
      results[option.id].scores.push(total);
      if (total > bestScore) {
        bestScore = total;
        bestId = option.id;
      }
    });
    results[bestId].wins += 1;

    if ((iteration + 1) % safeChunkSize === 0 && iteration + 1 < safeIterations) {
      await yieldToMain();
      throwIfAborted(signal);
    }
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
    scenarioId: safeScenarioId,
    fingerprint,
    generatedAt: new Date().toISOString(),
    results: summary,
  };
}

/** A saved stress test is stale once any input it depended on has changed. */
export function isStressTestStale(state, result = state.lastStressTest) {
  if (!result?.results?.length) return false;
  if (!result.fingerprint) return true;
  return stressFingerprint(state, result.scenarioId) !== result.fingerprint;
}

export function summarizeWorkspace(state) {
  const ranking = rankOptions(state);
  const activeScenario = getScenario(state);
  return {
    version: state.version ?? WORKSPACE_VERSION,
    title: state.brief?.title ?? 'Untitled decision',
    status: state.committedDecision ? 'committed' : state.stagedRecommendation ? 'awaiting-human-review' : 'in-progress',
    activeScenario: { id: activeScenario?.id ?? 'base' },
    counts: {
      options: state.options.length,
      criteria: state.criteria.length,
      evidenceCells: state.options.length * state.criteria.length,
      evidenceGaps: findEvidenceGaps(state).length,
      assumptions: state.assumptions.length,
      scenarios: state.scenarios.length,
      activity: (state.activity ?? []).length,
    },
    leaders: ranking.slice(0, 1).map(({ optionId, option, score, confidence }) => ({ optionId, option, score, confidence })),
    stagedRecommendation: state.stagedRecommendation ? {
      optionId: state.stagedRecommendation.optionId,
      actor: state.stagedRecommendation.actor,
      stagedAt: state.stagedRecommendation.stagedAt,
    } : null,
    committedDecision: state.committedDecision ? {
      optionId: state.committedDecision.optionId,
      committedAt: state.committedDecision.committedAt,
    } : null,
    latestActivity: state.activity?.[0] ? {
      id: state.activity[0].id,
      actor: state.activity[0].actor,
      at: state.activity[0].at,
    } : null,
  };
}

/**
 * Return one bounded page of `items`. `pageSize` is an upper bound: the page
 * shrinks item by item until it fits the serialized budget, so following
 * nextCursor always recovers the complete collection.
 */
function page(items, section, state, cursor = 0, pageSize = TOOL_RESULT_LIMITS.defaultPageSize) {
  const safeCursor = Math.round(clamp(cursor, 0, items.length));
  const requested = Math.round(clamp(pageSize, 1, TOOL_RESULT_LIMITS.pageSize));
  let count = Math.min(items.length - safeCursor, requested);
  let result;
  do {
    const end = safeCursor + count;
    result = {
      section,
      scenarioId: state.activeScenarioId || 'base',
      items: deepClone(items.slice(safeCursor, end)),
      page: {
        cursor: safeCursor,
        pageSize: requested,
        returned: count,
        total: items.length,
        nextCursor: end < items.length ? end : null,
        hasMore: end < items.length,
      },
    };
    if (JSON.stringify(result).length <= TOOL_RESULT_LIMITS.serializedChars) return result;
    count -= 1;
  } while (count > 0);
  throw new RangeError(`A single ${section} item exceeded the ${TOOL_RESULT_LIMITS.serializedChars}-character result budget.`);
}

function overviewLabel(value) {
  const text = String(value ?? '');
  const limit = TOOL_RESULT_LIMITS.overviewLabelChars;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function matrixRows(state) {
  const rows = [];
  for (const option of state.options) {
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id);
      rows.push({
        optionId: option.id,
        criterionId: criterion.id,
        score: cell.score,
        confidence: cell.confidence,
        hasEvidence: cell.evidence.length > 0,
      });
    }
  }
  return rows;
}

function textFragments(value, maximum = TOOL_RESULT_LIMITS.textFragmentChars) {
  const text = String(value ?? '');
  if (!text) return [''];
  const fragments = [];
  for (let cursor = 0; cursor < text.length; cursor += maximum) {
    fragments.push(text.slice(cursor, cursor + maximum));
  }
  return fragments;
}

function fragmentRows(base, field, value) {
  const fragments = textFragments(value);
  return fragments.map((fragment, index) => ({
    ...base,
    field,
    fragment,
    fragmentIndex: index,
    fragmentCount: fragments.length,
  }));
}

function evidenceRows(state) {
  const rows = [];
  for (const option of state.options) {
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id);
      rows.push(...fragmentRows({
        optionId: option.id,
        option: option.name,
        criterionId: criterion.id,
        criterion: criterion.name,
        score: cell.score,
        confidence: cell.confidence,
      }, 'evidence', cell.evidence));
    }
  }
  return rows;
}

function scenarioOverrideRows(state) {
  const rows = [];
  for (const scenario of state.scenarios) {
    for (const [criterionId, weight] of Object.entries(scenario.weightOverrides ?? {})) {
      rows.push({ scenarioId: scenario.id, kind: 'weight', criterionId, weight });
    }
    for (const [optionId, optionCells] of Object.entries(scenario.scoreOverrides ?? {})) {
      for (const [criterionId, cell] of Object.entries(optionCells ?? {})) {
        const { evidence = '', ...numbers } = deepClone(cell);
        rows.push(...fragmentRows({ scenarioId: scenario.id, kind: 'score', optionId, criterionId, ...numbers }, 'evidence', evidence));
      }
    }
  }
  return rows;
}

export const WORKSPACE_READ_SECTIONS = Object.freeze([
  'overview',
  'brief',
  'options',
  'criteria',
  'matrix',
  'evidence',
  'assumptions',
  'scenarios',
  'scenario-overrides',
  'recommendation',
  'stress-test',
  'activity',
]);

/**
 * Return one bounded page of a single section. Sections paginate
 * independently; a null nextCursor means that section is fully read.
 */
export function readWorkspacePage(state, {
  section = 'overview',
  cursor = 0,
  pageSize = TOOL_RESULT_LIMITS.defaultPageSize,
} = {}) {
  if (!WORKSPACE_READ_SECTIONS.includes(section)) throw new RangeError(`Unknown workspace section: ${section}`);
  const scenarioId = state.activeScenarioId || 'base';
  if (section === 'overview') {
    const weights = normalizedWeights(state);
    const result = {
      section,
      scenarioId,
      workspace: summarizeWorkspace(state),
      ranking: rankOptions(state).map(({ optionId, option, score, confidence }) => ({
        optionId, option: overviewLabel(option), score, confidence,
      })),
      criteria: state.criteria.map((criterion) => ({
        id: criterion.id,
        name: overviewLabel(criterion.name),
        normalizedWeight: Number((weights[criterion.id] ?? 0).toFixed(4)),
      })),
      availableSections: [...WORKSPACE_READ_SECTIONS],
      page: { cursor: 0, pageSize: 1, returned: 1, total: 1, nextCursor: null, hasMore: false },
    };
    if (JSON.stringify(result).length > TOOL_RESULT_LIMITS.defaultReadChars) {
      throw new RangeError(`The overview exceeded the ${TOOL_RESULT_LIMITS.defaultReadChars}-character default read budget.`);
    }
    return result;
  }

  if (section === 'brief') {
    return page(Object.entries(state.brief).flatMap(([field, value]) => (
      fragmentRows({}, field, value)
    )), section, state, cursor, pageSize);
  }

  if (section === 'options') {
    const rankedById = new Map(rankOptions(state).map((item, index) => [item.optionId, { rank: index + 1, score: item.score, confidence: item.confidence }]));
    return page(state.options.map((option) => ({ ...deepClone(option), ...rankedById.get(option.id) })), section, state, cursor, pageSize);
  }
  if (section === 'criteria') {
    const weights = normalizedWeights(state);
    const scenario = getScenario(state);
    return page(state.criteria.map((criterion) => ({
      ...deepClone(criterion),
      effectiveWeight: scenario?.weightOverrides?.[criterion.id] ?? criterion.weight,
      normalizedWeight: weights[criterion.id] ?? 0,
    })), section, state, cursor, pageSize);
  }
  if (section === 'matrix') return page(matrixRows(state), section, state, cursor, pageSize);
  if (section === 'evidence') return page(evidenceRows(state), section, state, cursor, pageSize);
  if (section === 'assumptions') return page(state.assumptions, section, state, cursor, pageSize);
  if (section === 'scenarios') {
    return page(state.scenarios.flatMap((scenario) => fragmentRows({
      id: scenario.id,
      name: scenario.name,
      weightOverrideCount: Object.keys(scenario.weightOverrides ?? {}).length,
      scoreOverrideCount: Object.values(scenario.scoreOverrides ?? {})
        .reduce((total, cells) => total + Object.keys(cells ?? {}).length, 0),
    }, 'description', scenario.description)), section, state, cursor, pageSize);
  }
  if (section === 'scenario-overrides') return page(scenarioOverrideRows(state), section, state, cursor, pageSize);
  if (section === 'recommendation') {
    const recommendation = state.committedDecision
      ? { kind: 'committed', ...state.committedDecision }
      : state.stagedRecommendation
        ? { kind: 'staged', ...state.stagedRecommendation }
        : null;
    if (!recommendation) return page([], section, state, cursor, pageSize);
    const field = recommendation.kind === 'committed' ? 'note' : 'rationale';
    const { [field]: longText, ...metadata } = recommendation;
    return page(fragmentRows(metadata, field, longText), section, state, cursor, pageSize);
  }
  if (section === 'stress-test') {
    const test = state.lastStressTest;
    if (!test) return page([], section, state, cursor, pageSize);
    const rows = [{
      kind: 'metadata',
      iterations: test.iterations,
      seed: test.seed,
      scenarioId: test.scenarioId,
      generatedAt: test.generatedAt,
    }, ...test.results.map((result) => ({ kind: 'result', ...deepClone(result) }))];
    return page(rows, section, state, cursor, pageSize);
  }
  return page(state.activity ?? [], section, state, cursor, pageSize);
}

export function findEvidenceGapsPage(state, { cursor = 0, pageSize = TOOL_RESULT_LIMITS.defaultPageSize } = {}) {
  return page(findEvidenceGaps(state), 'evidence-gaps', state, cursor, pageSize);
}

/** Collapse line breaks so workspace text cannot start a new Markdown block. */
function inline(value) {
  return String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

function escapeTable(value) {
  return inline(value).replaceAll('|', '\\|');
}

export function exportMarkdown(state) {
  const ranking = rankOptions(state);
  const scenario = getScenario(state);
  const lines = [
    `# ${inline(state.brief.title) || 'Untitled decision'}`,
    '',
    `**Question:** ${inline(state.brief.question) || 'Not defined'}`,
    '',
    `**Active scenario:** ${inline(scenario?.name) || 'Base case'}`,
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
    lines.push(`### ${inline(option.name)}`, '');
    for (const criterion of state.criteria) {
      const cell = effectiveCell(state, option.id, criterion.id);
      lines.push(`- **${inline(criterion.name)}:** ${cell.score.toFixed(1)}/10, ${cell.confidence.toFixed(0)}% confidence${cell.evidence ? ` — ${inline(cell.evidence)}` : ' — evidence not recorded'}`);
    }
    lines.push('');
  }

  lines.push('## Assumptions', '');
  if (state.assumptions.length) {
    state.assumptions.forEach((assumption) => lines.push(`- [${assumption.status === 'validated' ? 'x' : ' '}] ${inline(assumption.text)} (${assumption.impact} impact)`));
  } else {
    lines.push('- No assumptions recorded.');
  }
  lines.push('');

  if (state.stagedRecommendation) {
    const option = state.options.find((item) => item.id === state.stagedRecommendation.optionId);
    lines.push('## Staged recommendation', '', `**${inline(option?.name) || 'Unknown option'}**`, '', state.stagedRecommendation.rationale, '');
  }
  if (state.committedDecision) {
    const option = state.options.find((item) => item.id === state.committedDecision.optionId);
    lines.push('## Human-committed decision', '', `**${inline(option?.name) || 'Unknown option'}**`, '', state.committedDecision.note || '', '', `Committed at ${state.committedDecision.committedAt}.`, '');
  }

  // Free-form prose blocks (context, constraints, rationale, note) may keep
  // their line breaks; only single-line constructs above are collapsed.
  const exportedAt = normalizedTimestamp(state.activity?.[0]?.at, new Date().toISOString());
  lines.push('---', '', `Exported from Forkcast snapshot ${exportedAt}.`);
  return lines.join('\n');
}

/**
 * Return a bounded slice of the Markdown export. Call again with nextCursor
 * until it is null to reconstruct the complete record without an oversized
 * tool result.
 */
export function exportMarkdownPage(state, { cursor = 0, maxChars = TOOL_RESULT_LIMITS.defaultExportChars } = {}) {
  const markdown = exportMarkdown(state);
  const safeCursor = Math.round(clamp(cursor, 0, markdown.length));
  const safeMaxChars = Math.round(clamp(maxChars, 500, TOOL_RESULT_LIMITS.exportChars));
  let end = Math.min(markdown.length, safeCursor + safeMaxChars);
  let result;
  do {
    result = {
      markdown: markdown.slice(safeCursor, end),
      cursor: safeCursor,
      chars: end - safeCursor,
      totalChars: markdown.length,
      nextCursor: end < markdown.length ? end : null,
      hasMore: end < markdown.length,
    };
    if (JSON.stringify(result).length <= TOOL_RESULT_LIMITS.serializedChars) return result;
    end = safeCursor + Math.max(1, Math.floor((end - safeCursor) * 0.8));
  } while (end > safeCursor);
  throw new RangeError('The Markdown page could not fit within the serialized result budget.');
}
