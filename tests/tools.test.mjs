import test from 'node:test';
import assert from 'node:assert/strict';
import { getExample } from '../src/data.js';
import { deepClone, effectiveCell, findEvidenceGaps, makeId, normalizeWorkspace, summarizeWorkspace } from '../src/engine.js';
import { createTools } from '../src/tools.js';
import { validateInput } from '../src/webmcp.js';

/** Minimal in-memory host mirroring app.js: clone → update → normalize → history. */
function createHost(workspace = getExample('launch')) {
  const state = {
    workspace: normalizeWorkspace(workspace),
    undoStack: [],
    focused: [],
  };
  const commit = (next, entry) => {
    state.workspace = normalizeWorkspace(next, state.workspace);
    if (entry) state.undoStack.push(entry);
    return summarizeWorkspace(state.workspace);
  };
  const host = {
    state,
    getWorkspace: () => state.workspace,
    getUndoStack: () => state.undoStack,
    mutate(message, updater, { actor = 'agent' } = {}) {
      if (state.workspace.committedDecision) throw new Error('This decision is committed.');
      const previous = deepClone(state.workspace);
      const next = deepClone(state.workspace);
      updater(next);
      next.activity.unshift({ id: makeId('activity'), at: new Date().toISOString(), actor, text: message });
      return commit(next, { workspace: previous, actor, message });
    },
    undo(actor) {
      const entry = state.undoStack.pop();
      if (!entry) throw new Error('There is no change to undo.');
      const next = deepClone(entry.workspace);
      next.activity.unshift({ id: makeId('activity'), at: new Date().toISOString(), actor, text: `Undid: ${entry.message}` });
      return commit(next, null);
    },
    focus: (section) => state.focused.push(section),
  };
  return host;
}

function tool(host, name) {
  const definition = createTools(host).find((item) => item.name === name);
  assert.ok(definition, `tool ${name} should be registered`);
  return {
    definition,
    run: async (input = {}, options = {}) => {
      validateInput(definition.inputSchema, input);
      return definition.execute(input, options);
    },
  };
}

test('every tool uses a closed schema, annotations, and a unique name', () => {
  const tools = createTools(createHost());
  assert.equal(tools.length, 19);
  assert.equal(new Set(tools.map((item) => item.name)).size, tools.length);
  for (const item of tools) {
    assert.equal(item.inputSchema.type, 'object', `${item.name} schema type`);
    assert.equal(item.inputSchema.additionalProperties, false, `${item.name} must be closed`);
    assert.equal(typeof item.annotations.readOnlyHint, 'boolean', `${item.name} readOnlyHint`);
    assert.equal(typeof item.annotations.untrustedContentHint, 'boolean', `${item.name} untrustedContentHint`);
    assert.ok(item.description.length > 20, `${item.name} needs a description`);
    for (const [key, property] of Object.entries(item.inputSchema.properties ?? {})) {
      assert.ok(property.description, `${item.name}.${key} needs a description`);
    }
  }
  assert.ok(!tools.some((item) => /commit|finalize/i.test(item.name)));
});

test('scoring without evidence preserves the existing evidence in base and scenario layers', async () => {
  const host = createHost();
  const before = host.getWorkspace().scores['launch-self-serve']['criterion-reach'].evidence;
  await tool(host, 'decision_score_option').run({ optionId: 'launch-self-serve', criterionId: 'criterion-reach', score: 6, confidence: 70 });
  const cell = host.getWorkspace().scores['launch-self-serve']['criterion-reach'];
  assert.deepEqual(cell, { score: 6, confidence: 70, evidence: before });

  await tool(host, 'decision_score_option').run({
    optionId: 'launch-marketplace', criterionId: 'criterion-reach', score: 9.5, confidence: 80, scenarioId: 'scenario-competitor',
  });
  const scenario = host.getWorkspace().scenarios.find((item) => item.id === 'scenario-competitor');
  assert.deepEqual(scenario.scoreOverrides['launch-marketplace']['criterion-reach'], { score: 9.5, confidence: 80 });
  assert.equal(
    effectiveCell(host.getWorkspace(), 'launch-marketplace', 'criterion-reach', 'scenario-competitor').evidence,
    host.getWorkspace().scores['launch-marketplace']['criterion-reach'].evidence,
  );
  assert.ok(!findEvidenceGaps(host.getWorkspace(), 'scenario-competitor').some((gap) => (
    gap.optionId === 'launch-marketplace' && gap.criterionId === 'criterion-reach' && gap.reasons.includes('missing evidence')
  )));

  await assert.rejects(
    tool(host, 'decision_score_option').run({ optionId: 'launch-self-serve', criterionId: 'criterion-reach', score: 1, confidence: 1, scenarioId: 'nope' }),
    /Unknown scenario id/,
  );
});

test('agent undo reverts agent changes but never crosses a human edit', async () => {
  const host = createHost();
  await assert.rejects(tool(host, 'decision_undo_last_change').run(), /There is no agent change to undo/);

  await tool(host, 'decision_define_brief').run({ title: 'Agent title' });
  assert.equal(host.getWorkspace().brief.title, 'Agent title');
  await tool(host, 'decision_undo_last_change').run();
  assert.equal(host.getWorkspace().brief.title, 'Launch Atlas Notes');

  await tool(host, 'decision_define_brief').run({ title: 'Agent title again' });
  host.mutate('Human renamed the decision.', (draft) => { draft.brief.title = 'Human title'; }, { actor: 'human' });
  await assert.rejects(tool(host, 'decision_undo_last_change').run(), /belongs to the human/);
  assert.equal(host.getWorkspace().brief.title, 'Human title');
  assert.equal(host.getUndoStack().length, 2);
});

test('commitment removes every write tool and leaves the four read/focus/export tools', async () => {
  const host = createHost();
  await tool(host, 'decision_stage_recommendation').run({ optionId: 'launch-design-partners', rationale: 'Leads the base case.' });
  assert.equal(createTools(host).length, 19);

  host.mutate('Human committed the final decision.', (draft) => {
    draft.committedDecision = { optionId: 'launch-design-partners', note: 'Approved.', committedAt: new Date().toISOString() };
  }, { actor: 'human' });

  const remaining = createTools(host);
  assert.deepEqual(remaining.map((item) => item.name), [
    'decision_read_workspace',
    'decision_find_evidence_gaps',
    'decision_export_markdown',
    'decision_focus_view',
  ]);
  assert.ok(remaining.every((item) => item.name !== 'decision_undo_last_change'));
  const overview = await tool(host, 'decision_read_workspace').run({});
  assert.equal(overview.workspace.status, 'committed');
});

test('precondition failures are readable errors rather than missing tools', async () => {
  const host = createHost();
  await assert.rejects(tool(host, 'decision_clear_staged_recommendation').run(), /no staged recommendation/);
  await assert.rejects(tool(host, 'decision_update_option').run({ optionId: 'missing', name: 'x' }), /Unknown option id/);
  await assert.rejects(tool(host, 'decision_set_assumption_status').run({ assumptionId: 'missing', status: 'testing' }), /Unknown assumption id/);
  await assert.rejects(tool(host, 'decision_activate_scenario').run({ scenarioId: 'missing' }), /Unknown scenario id/);
  await assert.rejects(tool(host, 'decision_focus_view').run({ section: 'nowhere' }), /must be one of/);
  await tool(host, 'decision_focus_view').run({ section: 'matrix' });
  assert.deepEqual(host.state.focused, ['matrix']);
});

test('removing an option needs no ceremony flag, records a traceable snapshot, and is undoable', async () => {
  const host = createHost();
  const removal = tool(host, 'decision_remove_option');
  assert.ok(!('confirm' in removal.definition.inputSchema.properties));
  await assert.rejects(removal.run({ optionId: 'launch-marketplace', confirm: true }), /confirm is not allowed/);

  const result = await removal.run({ optionId: 'launch-marketplace' });
  assert.equal(result.removed.name, 'Marketplace partnership');
  assert.equal(result.removed.of, 3);
  assert.equal(Object.keys(result.removed.cells).length, 4);
  assert.equal(result.workspace.counts.options, 2);
  assert.ok(!host.getWorkspace().options.some((item) => item.id === 'launch-marketplace'));
  assert.ok(!('launch-marketplace' in host.getWorkspace().scores));
  assert.ok(!host.getWorkspace().scenarios.some((scenario) => 'launch-marketplace' in (scenario.scoreOverrides ?? {})));
  const entry = host.getWorkspace().activity[0].text;
  assert.match(entry, /removed option “Marketplace partnership” \(ranked 3 of 3 at \d\.\d\d; Learning velocity 6\.2\/44%/);

  await tool(host, 'decision_undo_last_change').run();
  assert.equal(host.getWorkspace().options.length, 3);
  assert.equal(host.getWorkspace().scores['launch-marketplace']['criterion-reach'].score, 9);

  await removal.run({ optionId: 'launch-marketplace' });
  await removal.run({ optionId: 'launch-self-serve' });
  await assert.rejects(removal.run({ optionId: 'launch-design-partners' }), /at least one option/);
});

test('stress test tool targets the active scenario by default and accepts an explicit scenario', async () => {
  const host = createHost();
  await tool(host, 'decision_activate_scenario').run({ scenarioId: 'scenario-budget-cut' });
  const active = await tool(host, 'decision_run_stress_test').run({ iterations: 200, seed: 3 });
  assert.equal(active.stressTest.scenarioId, 'scenario-budget-cut');
  assert.equal(host.getWorkspace().lastStressTest.scenarioId, 'scenario-budget-cut');
  assert.match(host.getWorkspace().activity[0].text, /scenario “Budget cut”/);

  const explicit = await tool(host, 'decision_run_stress_test').run({ iterations: 200, seed: 3, scenarioId: 'base' });
  assert.equal(explicit.stressTest.scenarioId, 'base');
  assert.match(host.getWorkspace().activity[0].text, /the base case/);
  await assert.rejects(tool(host, 'decision_run_stress_test').run({ scenarioId: 'missing' }), /Unknown scenario id/);
});

test('activity entries name the affected items instead of exposing raw ids', async () => {
  const host = createHost();
  await tool(host, 'decision_update_option').run({ optionId: 'launch-marketplace', description: 'Clarified.' });
  await tool(host, 'decision_set_assumption_status').run({ assumptionId: 'assumption-price', status: 'validated' });
  await tool(host, 'decision_activate_scenario').run({ scenarioId: 'scenario-budget-cut' });
  await tool(host, 'decision_set_criterion_weight').run({ criterionId: 'criterion-load', weight: 40, scenarioId: 'scenario-budget-cut' });
  const [weight, scenario, assumption, option] = host.getWorkspace().activity.map((item) => item.text);
  assert.match(option, /“Marketplace partnership”/);
  assert.match(assumption, /Design partners will convert/);
  assert.match(scenario, /“Budget cut”/);
  assert.match(weight, /Team sustainability weight to 40 in Budget cut/);
  for (const entry of [weight, scenario, assumption, option]) {
    assert.ok(!/(launch|assumption|scenario|criterion)-[a-z]/.test(entry), `activity leaks an id: ${entry}`);
  }
});
