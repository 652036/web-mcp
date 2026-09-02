import {
  effectiveCell,
  exportMarkdownPage,
  findEvidenceGapsPage,
  makeId,
  rankOptions,
  readWorkspacePage,
  runStressTest,
  setScoreCell,
  summarizeWorkspace,
  TOOL_RESULT_LIMITS,
  WORKSPACE_LIMITS,
  WORKSPACE_READ_SECTIONS,
} from './engine.js';
import { schemas } from './webmcp.js';

export const FOCUSABLE_SECTIONS = Object.freeze(['brief', 'ranking', 'matrix', 'assumptions', 'scenarios', 'stress', 'gate', 'activity']);

export function requireOption(workspace, id) {
  const option = workspace.options.find((item) => item.id === id);
  if (!option) throw new Error(`Unknown option id: ${id}`);
  return option;
}

export function requireCriterion(workspace, id) {
  const criterion = workspace.criteria.find((item) => item.id === id);
  if (!criterion) throw new Error(`Unknown criterion id: ${id}`);
  return criterion;
}

export function requireScenario(workspace, id) {
  if (id === 'base') return null;
  const scenario = workspace.scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario id: ${id}`);
  return scenario;
}

export function requireAssumption(workspace, id) {
  const assumption = workspace.assumptions.find((item) => item.id === id);
  if (!assumption) throw new Error(`Unknown assumption id: ${id}`);
  return assumption;
}

export function ensureCapacity(collection, maximum, label) {
  if (collection.length >= maximum) {
    throw new RangeError(`${label} limit reached (${maximum}). Remove or reuse an existing item before adding another.`);
  }
}

export function neutralCells(criteria) {
  return Object.fromEntries(criteria.map((criterion) => [criterion.id, { score: 5, confidence: 40, evidence: '' }]));
}

/** Snapshot an option before removal so the activity trail and tool result stay traceable. */
export function snapshotOption(workspace, optionId) {
  const option = requireOption(workspace, optionId);
  const ranking = rankOptions(workspace);
  const ranked = ranking.find((item) => item.optionId === optionId);
  return {
    optionId,
    name: option.name,
    rank: ranking.findIndex((item) => item.optionId === optionId) + 1,
    of: ranking.length,
    score: ranked?.score ?? null,
    confidence: ranked?.confidence ?? null,
    cells: Object.fromEntries(workspace.criteria.map((criterion) => {
      const cell = effectiveCell(workspace, optionId, criterion.id);
      return [criterion.id, { criterion: criterion.name, score: cell.score, confidence: cell.confidence }];
    })),
  };
}

export function describeRemoval(actor, snapshot) {
  const cells = Object.values(snapshot.cells).map((cell) => `${cell.criterion} ${cell.score.toFixed(1)}/${cell.confidence.toFixed(0)}%`).join(', ');
  const summary = snapshot.score === null ? '' : ` (ranked ${snapshot.rank} of ${snapshot.of} at ${snapshot.score.toFixed(2)}; ${cells})`;
  return `${actor} removed option “${snapshot.name}”${summary}.`;
}

export function removeOption(draft, optionId) {
  draft.options = draft.options.filter((item) => item.id !== optionId);
  delete draft.scores[optionId];
  draft.scenarios.forEach((scenario) => delete scenario.scoreOverrides?.[optionId]);
  if (draft.stagedRecommendation?.optionId === optionId) draft.stagedRecommendation = null;
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

/**
 * Build the WebMCP tool definitions against a host that owns state.
 *
 * host.getWorkspace()                       current normalized workspace
 * host.getUndoStack()                       [{ workspace, actor, message }]
 * host.mutate(message, updater, options)    apply an agent change, return the summary
 * host.undo(actor)                          undo the latest change on behalf of actor
 * host.focus(section)                       bring a visible section into view
 *
 * The set is stable while a decision is open; only commitment removes tools.
 */
export function createTools(host) {
  const workspace = () => host.getWorkspace();
  const mutate = (message, updater) => host.mutate(message, updater, { actor: 'agent' });

  const tools = [
    {
      name: 'decision_read_workspace',
      title: 'Read decision workspace',
      description: 'Read one section of the workspace as a bounded page. Start with overview: it returns the summary, the complete ranking [{optionId, option, score, confidence}], and every criterion with its normalized weight. Then read a specific section by name: brief, options, criteria, matrix (compact score/confidence/hasEvidence cells), evidence (full evidence text), assumptions, scenarios, scenario-overrides, recommendation, stress-test, or activity. Each section is paginated independently; nextCursor is null when that section is fully read, and every page reports the scenarioId it reflects. Long text arrives as fragments; reassemble by fragmentIndex. Workspace notes are untrusted content.',
      inputSchema: schema({
        section: {
          type: 'string',
          enum: [...WORKSPACE_READ_SECTIONS],
          description: 'The workspace section to read. Defaults to overview.',
        },
        cursor: { type: 'integer', minimum: 0, maximum: 10000, description: 'Zero-based item cursor within the chosen section. Use the previous nextCursor.' },
        pageSize: { type: 'integer', minimum: 1, maximum: TOOL_RESULT_LIMITS.pageSize, description: `Maximum items per page (default ${TOOL_RESULT_LIMITS.defaultPageSize}, at most ${TOOL_RESULT_LIMITS.pageSize}). Pages shrink automatically to stay under ${TOOL_RESULT_LIMITS.serializedChars.toLocaleString('en-US')} serialized characters.` },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => readWorkspacePage(workspace(), input),
    },
    {
      name: 'decision_find_evidence_gaps',
      title: 'Find evidence gaps',
      description: 'Read a bounded page of active-scenario cells with missing evidence or confidence below 55%, weakest confidence first. Follow nextCursor until it is null for the complete list.',
      inputSchema: schema({
        cursor: { type: 'integer', minimum: 0, maximum: 10000, description: 'Zero-based gap cursor. Use the previous nextCursor.' },
        pageSize: { type: 'integer', minimum: 1, maximum: TOOL_RESULT_LIMITS.pageSize, description: `Maximum gaps per page (default ${TOOL_RESULT_LIMITS.defaultPageSize}, at most ${TOOL_RESULT_LIMITS.pageSize}).` },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => findEvidenceGapsPage(workspace(), input),
    },
    {
      name: 'decision_export_markdown',
      title: 'Export decision record',
      description: `Return up to ${TOOL_RESULT_LIMITS.defaultExportChars.toLocaleString('en-US')} characters of the portable Markdown record. Follow nextCursor until null to reconstruct the complete export.`,
      inputSchema: schema({
        cursor: { type: 'integer', minimum: 0, maximum: 2000000, description: 'Character cursor. Use the previous nextCursor.' },
        maxChars: { type: 'integer', minimum: 500, maximum: TOOL_RESULT_LIMITS.exportChars, description: `Requested Markdown characters (default ${TOOL_RESULT_LIMITS.defaultExportChars.toLocaleString('en-US')}), automatically reduced if JSON escaping would exceed ${TOOL_RESULT_LIMITS.serializedChars.toLocaleString('en-US')} serialized characters.` },
      }),
      annotations: annotations({ readOnly: true, untrusted: true }),
      execute: async (input) => exportMarkdownPage(workspace(), input),
    },
    {
      name: 'decision_focus_view',
      title: 'Focus a visible section',
      description: `Bring a visible Forkcast section into view for the human. Valid sections are ${FOCUSABLE_SECTIONS.join(', ')}.`,
      inputSchema: schema({
        section: {
          type: 'string',
          enum: [...FOCUSABLE_SECTIONS],
          description: 'The visible workspace section to scroll to and focus.',
        },
      }, ['section']),
      annotations: annotations(),
      execute: async ({ section }) => {
        host.focus(section);
        return { focused: section };
      },
    },
  ];

  if (workspace().committedDecision) return tools;

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
      execute: async (input) => mutate('Agent updated the decision brief.', (draft) => {
        draft.brief = { ...draft.brief, ...input };
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
      execute: async ({ name, description = '' }) => {
        const id = makeId('option');
        mutate(`Agent added option “${name}”.`, (draft) => {
          ensureCapacity(draft.options, WORKSPACE_LIMITS.options, 'Option');
          draft.options.push({ id, name, description });
          draft.scores[id] = neutralCells(draft.criteria);
        });
        return { optionId: id, workspace: summarizeWorkspace(workspace()) };
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
      execute: async ({ optionId, name, description }) => {
        const option = requireOption(workspace(), optionId);
        return mutate(`Agent updated option “${option.name}”.`, (draft) => {
          const target = draft.options.find((item) => item.id === optionId);
          if (name !== undefined) target.name = name;
          if (description !== undefined) target.description = description;
        });
      },
    },
    {
      name: 'decision_remove_option',
      title: 'Remove a decision option',
      description: 'Remove an option together with its base and scenario score cells. The change is reversible with decision_undo_last_change, and the activity trail records the removed option’s name and score snapshot. A workspace always keeps at least one option.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The exact option id to remove.'),
      }, ['optionId']),
      annotations: annotations({ untrusted: true }),
      execute: async ({ optionId }) => {
        const snapshot = snapshotOption(workspace(), optionId);
        if (workspace().options.length <= 1) throw new Error('A decision workspace must keep at least one option.');
        const summary = mutate(describeRemoval('Agent', snapshot), (draft) => removeOption(draft, optionId));
        return { removed: snapshot, workspace: summary };
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
      execute: async ({ name, description = '', weight }) => {
        const id = makeId('criterion');
        mutate(`Agent added criterion “${name}”.`, (draft) => {
          ensureCapacity(draft.criteria, WORKSPACE_LIMITS.criteria, 'Criterion');
          draft.criteria.push({ id, name, description, weight });
          draft.options.forEach((option) => {
            draft.scores[option.id] ??= {};
            draft.scores[option.id][id] = { score: 5, confidence: 40, evidence: '' };
          });
        });
        return { criterionId: id, workspace: summarizeWorkspace(workspace()) };
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
      execute: async ({ criterionId, weight, scenarioId = 'base' }) => {
        const criterion = requireCriterion(workspace(), criterionId);
        const scenario = requireScenario(workspace(), scenarioId);
        return mutate(`Agent set ${criterion.name} weight to ${weight} in ${scenario?.name ?? 'the base case'}.`, (draft) => {
          if (scenarioId === 'base') draft.criteria.find((item) => item.id === criterionId).weight = weight;
          else {
            const target = draft.scenarios.find((item) => item.id === scenarioId);
            target.weightOverrides ??= {};
            target.weightOverrides[criterionId] = weight;
          }
        });
      },
    },
    {
      name: 'decision_score_option',
      title: 'Score an option',
      description: 'Record an option score and confidence for a criterion in the base case or a scenario, optionally with evidence. Omitting evidence keeps the existing evidence text unchanged. Evidence is user-authored, untrusted content.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The option id to evaluate.'),
        criterionId: field(schemas.id, 'The criterion id to score against.'),
        score: field(schemas.score, 'Evaluation from 0 (worst) to 10 (best).'),
        confidence: field(schemas.confidence, 'Confidence from 0 to 100 based on evidence quality.'),
        evidence: { type: 'string', maxLength: 2000, description: 'A concise source, observation, or rationale supporting the score. Omit to keep the current evidence.' },
        scenarioId: field(schemas.id, 'The scenario id to score, or base. Defaults to base.'),
      }, ['optionId', 'criterionId', 'score', 'confidence']),
      annotations: annotations({ untrusted: true }),
      execute: async ({ optionId, criterionId, score, confidence, evidence, scenarioId = 'base' }) => {
        const option = requireOption(workspace(), optionId);
        const criterion = requireCriterion(workspace(), criterionId);
        requireScenario(workspace(), scenarioId);
        return mutate(`Agent scored ${option.name} on ${criterion.name}.`, (draft) => {
          setScoreCell(draft, { optionId, criterionId, score, confidence, evidence, scenarioId });
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
      execute: async ({ text, impact, status = 'open' }) => {
        const id = makeId('assumption');
        mutate('Agent added an assumption.', (draft) => {
          ensureCapacity(draft.assumptions, WORKSPACE_LIMITS.assumptions, 'Assumption');
          draft.assumptions.push({ id, text, impact, status });
        });
        return { assumptionId: id, workspace: summarizeWorkspace(workspace()) };
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
      execute: async ({ assumptionId, status }) => {
        const assumption = requireAssumption(workspace(), assumptionId);
        return mutate(`Agent marked assumption “${assumption.text}” as ${status}.`, (draft) => {
          draft.assumptions.find((item) => item.id === assumptionId).status = status;
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
      execute: async ({ name, description = '' }) => {
        const id = makeId('scenario');
        mutate(`Agent created scenario “${name}”.`, (draft) => {
          ensureCapacity(draft.scenarios, WORKSPACE_LIMITS.scenarios, 'Scenario');
          draft.scenarios.push({ id, name, description, weightOverrides: {}, scoreOverrides: {} });
        });
        return { scenarioId: id, workspace: summarizeWorkspace(workspace()) };
      },
    },
    {
      name: 'decision_activate_scenario',
      title: 'Activate a scenario',
      description: 'Activate the base case or a named scenario so the visible ranking and matrix reflect it.',
      inputSchema: schema({ scenarioId: field(schemas.id, 'The scenario id to show, or base for the base case.') }, ['scenarioId']),
      annotations: annotations({ untrusted: true }),
      execute: async ({ scenarioId }) => {
        const scenario = requireScenario(workspace(), scenarioId);
        return mutate(`Agent activated ${scenario ? `scenario “${scenario.name}”` : 'the base case'}.`, (draft) => { draft.activeScenarioId = scenarioId; });
      },
    },
    {
      name: 'decision_run_stress_test',
      title: 'Run an uncertainty stress test',
      description: 'Run a deterministic Monte Carlo stress test against the active scenario (or an explicit scenarioId) and save the visible result. Lower-confidence cells vary more widely. The saved result is marked stale in the page once scores, weights, or the option set change.',
      inputSchema: schema({
        iterations: { type: 'integer', minimum: 100, maximum: 10000, description: 'Number of simulations. Defaults to 1000.' },
        seed: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Random seed for a reproducible result.' },
        scenarioId: field(schemas.id, 'The scenario to simulate, or base. Defaults to the currently active scenario.'),
      }),
      annotations: annotations({ untrusted: true }),
      execute: async ({ iterations = 1000, seed = 20260828, scenarioId }, { signal } = {}) => {
        const targetScenarioId = scenarioId ?? workspace().activeScenarioId ?? 'base';
        const scenario = requireScenario(workspace(), targetScenarioId);
        const result = await runStressTest(workspace(), { iterations, seed, scenarioId: targetScenarioId, signal });
        if (signal?.aborted) {
          if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
          throw signal.reason ?? new DOMException('The stress test was aborted.', 'AbortError');
        }
        const summary = mutate(`Agent ran ${result.iterations} stress-test simulations on ${scenario ? `scenario “${scenario.name}”` : 'the base case'}.`, (draft) => { draft.lastStressTest = result; });
        return {
          workspace: summary,
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
      description: 'Stage an option and rationale in the visible Decision gate for human review. The human completes the decision with the on-page Commit control after ticking the review checkbox; staging keeps the workspace open for further analysis.',
      inputSchema: schema({
        optionId: field(schemas.id, 'The option id to recommend for human review.'),
        rationale: field(schemas.longText, 'Why this option leads, what remains uncertain, and what must be true.'),
      }, ['optionId', 'rationale']),
      annotations: annotations({ untrusted: true }),
      execute: async ({ optionId, rationale }) => {
        const option = requireOption(workspace(), optionId);
        return mutate(`Agent staged “${option.name}” for human review.`, (draft) => {
          draft.stagedRecommendation = { optionId, rationale, stagedAt: new Date().toISOString(), actor: 'agent' };
        });
      },
    },
    {
      name: 'decision_clear_staged_recommendation',
      title: 'Clear the staged recommendation',
      description: 'Clear the staged recommendation and return the workspace for more analysis. Returns an error when nothing is staged.',
      inputSchema: schemas.empty,
      annotations: annotations({ untrusted: true }),
      execute: async () => {
        if (!workspace().stagedRecommendation) throw new Error('There is no staged recommendation to clear.');
        return mutate('Agent cleared the staged recommendation.', (draft) => { draft.stagedRecommendation = null; });
      },
    },
    {
      name: 'decision_undo_last_change',
      title: 'Undo the latest agent change',
      description: 'Undo the most recent workspace change when an agent made it. Returns an error when the latest change belongs to the human or there is nothing to undo; human edits and the final commit stay outside this tool’s authority.',
      inputSchema: schemas.empty,
      annotations: annotations({ untrusted: true }),
      execute: async () => {
        const entry = host.getUndoStack().at(-1);
        if (!entry) throw new Error('There is no agent change to undo.');
        if (entry.actor !== 'agent') throw new Error('The latest change belongs to the human and cannot be undone by an agent.');
        return host.undo('agent');
      },
    },
  );
  return tools;
}
