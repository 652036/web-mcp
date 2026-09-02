import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installWebMCP,
  uninstallWebMCP,
  validateInput,
} from '../src/webmcp.js';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 20 },
    score: { type: 'number', minimum: 0, maximum: 10 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['name', 'score'],
  additionalProperties: false,
};

test('preview validator accepts valid structured input', () => {
  assert.equal(validateInput(schema, { name: 'Option A', score: 7.5, tags: ['pilot'] }), true);
});

test('preview validator rejects missing and unknown properties', () => {
  assert.throws(() => validateInput(schema, { name: 'Option A' }), /score is required/);
  assert.throws(() => validateInput(schema, { name: 'Option A', score: 7, surprise: true }), /surprise is not allowed/);
});

test('preview validator enforces numeric and array bounds', () => {
  assert.throws(() => validateInput(schema, { name: 'Option A', score: 11 }), /at most 10/);
  assert.throws(() => validateInput(schema, { name: 'Option A', score: 7, tags: ['a', 'b', 'c', 'd'] }), /at most 3/);
});

test('preview validator enforces object and string shape constraints', () => {
  const strict = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[a-z]+-[a-z]+$' } },
    minProperties: 1,
    additionalProperties: false,
  };
  assert.throws(() => validateInput(strict, {}), /at least 1 field/);
  assert.throws(() => validateInput(strict, { id: 'not valid' }), /invalid format/);
  assert.equal(validateInput(strict, { id: 'option-alpha' }), true);
});

function makeTool({ name = 'read_state', version = 1, fail = false, description = 'Read test state.', execute } = {}) {
  return {
    name,
    title: 'Read state',
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: execute ?? (async () => {
      if (fail) throw new Error('Useful execution error');
      return { version };
    }),
  };
}

function fakeContext({ rejectWith = null, throwWith = null, rejectOnAbort = false } = {}) {
  const registrations = [];
  const live = new Map();
  return {
    registrations,
    live,
    signalFor(name) {
      return registrations.findLast((entry) => entry.definition.name === name)?.options.signal;
    },
    registerTool(definition, options = {}) {
      if (throwWith) throw throwWith;
      registrations.push({ definition, options });
      live.set(definition.name, definition);
      options.signal?.addEventListener('abort', () => {
        if (live.get(definition.name) === definition) live.delete(definition.name);
      });
      if (rejectWith) return Promise.reject(rejectWith);
      if (rejectOnAbort) {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('Registration aborted', 'AbortError')));
          setTimeout(resolve, 5);
        });
      }
      return Promise.resolve();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function withModelContext(context, callback) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { modelContext: context } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    return await callback();
  } finally {
    uninstallWebMCP();
    delete globalThis.__forkcastWebMCP;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
}

test('native registration awaits the current document.modelContext path', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    const statuses = [];
    const installed = installWebMCP([makeTool()], { onStatus: (status) => statuses.push(status) });
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'connecting');
    await installed.ready;
    assert.equal(context.registrations.length, 1);
    assert.equal(context.registrations[0].options.signal.aborted, false);
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'native');
    assert.deepEqual(statuses.map((status) => status.mode), ['connecting', 'native']);
  });
});

test('content-equivalent refreshes update handlers without registration churn', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    const first = installWebMCP([makeTool({ version: 1 })]);
    await first.ready;
    const originalSignal = context.registrations[0].options.signal;

    const second = installWebMCP([makeTool({ version: 2 })]);
    await second.ready;
    assert.equal(context.registrations.length, 1);
    assert.equal(originalSignal.aborted, false);
    assert.deepEqual(await second.execute('read_state', {}), { version: 2 });
    const nativeResult = await context.live.get('read_state').execute({});
    assert.deepEqual(nativeResult, { version: 2 });
  });
});

test('tool-set changes abort only removed tools and register only added ones', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    const first = installWebMCP([makeTool(), makeTool({ name: 'write_state' })]);
    await first.ready;
    const readSignal = context.signalFor('read_state');
    const writeSignal = context.signalFor('write_state');
    assert.equal(context.registrations.length, 2);

    const second = installWebMCP([makeTool(), makeTool({ name: 'write_state' }), makeTool({ name: 'read_more' })]);
    await second.ready;
    assert.equal(context.registrations.length, 3, 'unchanged tools are not re-registered');
    assert.equal(readSignal.aborted, false);
    assert.equal(writeSignal.aborted, false);
    assert.deepEqual([...context.live.keys()].sort(), ['read_more', 'read_state', 'write_state']);

    const third = installWebMCP([makeTool()]);
    await third.ready;
    assert.equal(context.registrations.length, 3, 'removals never trigger a re-registration');
    assert.equal(readSignal.aborted, false, 'the surviving tool keeps its original registration');
    assert.equal(writeSignal.aborted, true);
    assert.equal(context.signalFor('read_more').aborted, true);
    assert.deepEqual([...context.live.keys()], ['read_state']);
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'native');
    assert.equal(globalThis.__forkcastWebMCP.status().toolCount, 1);

    const fourth = installWebMCP([makeTool({ description: 'Changed description.' })]);
    await fourth.ready;
    assert.equal(readSignal.aborted, true, 'a changed definition replaces its own registration');
    assert.equal(context.registrations.length, 4);
    assert.equal(context.live.get('read_state').description, 'Changed description.');
  });
});

test('an intentionally aborted registration does not trigger the preview fallback', async () => {
  const context = fakeContext({ rejectOnAbort: true });
  await withModelContext(context, async () => {
    const first = installWebMCP([makeTool(), makeTool({ name: 'write_state' })]);
    await first.ready;
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'native');

    const second = installWebMCP([makeTool()]);
    await second.ready;
    await tick();
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'native');
    assert.equal(globalThis.__forkcastWebMCP.status().error, null);
    assert.deepEqual([...context.live.keys()], ['read_state']);
  });
});

test('registry changes requested during an in-flight call apply after the call returns', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    let releaseTool;
    const blocked = new Promise((resolve) => { releaseTool = resolve; });
    const mutating = makeTool({
      name: 'mutate_state',
      execute: async () => {
        // Simulate a handler whose state change refreshes the tool set while it runs.
        installWebMCP([makeTool(), makeTool({ name: 'mutate_state', description: 'Changed while running.' })]);
        await blocked;
        return { done: true };
      },
    });
    const installed = installWebMCP([makeTool(), mutating]);
    await installed.ready;
    const originalSignal = context.signalFor('mutate_state');

    const call = context.live.get('mutate_state').execute({});
    await tick();
    assert.equal(originalSignal.aborted, false, 'the running tool is not aborted mid-call');
    assert.equal(context.registrations.length, 2, 'no re-registration happens while the call is in flight');
    assert.equal(globalThis.__forkcastWebMCP.status().inFlight, 1);

    releaseTool();
    assert.deepEqual(await call, { done: true });
    await tick();
    assert.equal(originalSignal.aborted, true, 'the deferred refresh runs after the call settles');
    assert.equal(context.registrations.length, 3);
    assert.equal(context.live.get('mutate_state').description, 'Changed while running.');
    await globalThis.__forkcastWebMCP.ready();
    assert.equal(globalThis.__forkcastWebMCP.status().mode, 'native');
  });
});

test('embedded frames never register natively and report why', async () => {
  const context = fakeContext();
  const topDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'top');
  const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'top', { configurable: true, value: { frame: 'parent' } });
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { frame: 'child' } });
  try {
    await withModelContext(context, async () => {
      const statuses = [];
      const installed = installWebMCP([makeTool()], { onStatus: (status) => statuses.push(status) });
      await installed.ready;
      assert.equal(context.registrations.length, 0);
      assert.equal(installed.mode, 'preview');
      assert.equal(statuses.at(-1).reason, 'embedded');
      assert.equal(statuses.at(-1).error, null);
      assert.deepEqual(await installed.execute('read_state', {}), { version: 1 }, 'the Tool Lab still works when embedded');
    });
  } finally {
    if (topDescriptor) Object.defineProperty(globalThis, 'top', topDescriptor);
    else delete globalThis.top;
    if (selfDescriptor) Object.defineProperty(globalThis, 'self', selfDescriptor);
    else delete globalThis.self;
  }
});

test('native execution returns ordinary objects and rejects failures', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    const installed = installWebMCP([makeTool({ fail: true })]);
    await installed.ready;
    await assert.rejects(
      context.live.get('read_state').execute({}),
      /Useful execution error/,
    );
  });
});

test('registration failures fall back to the Tool Lab', async () => {
  const rejection = new DOMException('Missing tools permission', 'NotAllowedError');
  await withModelContext(fakeContext({ rejectWith: rejection }), async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const installed = installWebMCP([makeTool()]);
      await installed.ready;
      assert.equal(globalThis.__forkcastWebMCP.status().mode, 'preview');
      assert.match(globalThis.__forkcastWebMCP.status().error, /Missing tools permission/);
    } finally {
      console.warn = originalWarn;
    }
  });

  await withModelContext(fakeContext({ throwWith: new TypeError('Legacy implementation rejected the schema') }), async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const installed = installWebMCP([makeTool()]);
      await installed.ready;
      assert.equal(globalThis.__forkcastWebMCP.status().mode, 'preview');
      assert.match(globalThis.__forkcastWebMCP.status().error, /rejected the schema/);
    } finally {
      console.warn = originalWarn;
    }
  });
});
