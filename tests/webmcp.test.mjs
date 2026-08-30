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

function makeTool({ name = 'read_state', version = 1, fail = false } = {}) {
  return {
    name,
    title: 'Read state',
    description: 'Read test state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: async () => {
      if (fail) throw new Error('Useful execution error');
      return { version };
    },
  };
}

function fakeContext({ rejectWith = null, throwWith = null } = {}) {
  const registrations = [];
  const live = new Map();
  return {
    registrations,
    live,
    registerTool(definition, options = {}) {
      if (throwWith) throw throwWith;
      registrations.push({ definition, options });
      live.set(definition.name, definition);
      options.signal?.addEventListener('abort', () => {
        if (live.get(definition.name) === definition) live.delete(definition.name);
      });
      return rejectWith ? Promise.reject(rejectWith) : Promise.resolve();
    },
  };
}

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

test('tool-set changes abort the old registry before registering the new set', async () => {
  const context = fakeContext();
  await withModelContext(context, async () => {
    const first = installWebMCP([makeTool()]);
    await first.ready;
    const originalSignal = context.registrations[0].options.signal;

    const second = installWebMCP([makeTool(), makeTool({ name: 'read_more' })]);
    await second.ready;
    assert.equal(originalSignal.aborted, true);
    assert.deepEqual([...context.live.keys()].sort(), ['read_more', 'read_state']);
    assert.equal(globalThis.__forkcastWebMCP.status().toolCount, 2);
  });
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
