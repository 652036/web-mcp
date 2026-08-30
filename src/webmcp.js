function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

export function validateInput(schema = { type: 'object' }, value, path = 'input') {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => typeMatches(value, type))) {
    throw new TypeError(`${path} must be ${types.join(' or ')}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new RangeError(`${path} must be one of: ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new RangeError(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new RangeError(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new RangeError(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new RangeError(`${path} is too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) throw new RangeError(`${path} has an invalid format`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new RangeError(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new RangeError(`${path} allows at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((item, index) => validateInput(schema.items, item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      throw new RangeError(`${path} needs at least ${schema.minProperties} field(s)`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      throw new RangeError(`${path} allows at most ${schema.maxProperties} field(s)`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new TypeError(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      const unknown = keys.find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw new TypeError(`${path}.${unknown} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateInput(child, value[key], `${path}.${key}`);
    }
  }
  return true;
}

function errorMessage(value) {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return 'Tool execution failed.';
  }
}

let activeController = null;
let activeContext = null;
let activeFingerprint = '';
let activeGeneration = 0;
let activeMode = 'preview';
let activeError = null;
let activeReady = Promise.resolve();
let activeTools = [];

export function getModelContext() {
  return globalThis.document?.modelContext ?? null;
}

function fingerprint(tools) {
  return JSON.stringify(tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, annotations,
  })));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? new DOMException('The tool call was aborted.', 'AbortError');
}

async function executeActiveTool(name, input = {}, { signal } = {}) {
  const tool = activeTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown or unavailable tool: ${name}`);
  throwIfAborted(signal);
  validateInput(tool.inputSchema ?? schemas.empty, input);
  const result = await tool.execute(input, { signal });
  throwIfAborted(signal);
  return result;
}

function publicTools() {
  return activeTools.map(({ execute: _execute, ...tool }) => tool);
}

function status() {
  return {
    mode: activeMode,
    toolCount: activeTools.length,
    error: activeError ? errorMessage(activeError) : null,
  };
}

function exposePreviewBridge() {
  globalThis.__forkcastWebMCP = {
    listTools: publicTools,
    executeTool: (name, input = {}, options = {}) => executeActiveTool(name, input, options),
    status,
  };
}

function registrationDefinition(tool) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    // WebMCP's imperative API accepts ordinary structured-cloneable return
    // values. Validation and domain errors intentionally reject the promise so
    // the browser agent receives the native failure rather than an MCP-server
    // content envelope.
    execute: (input, options = {}) => executeActiveTool(
      tool.name,
      input ?? {},
      { signal: options.signal },
    ),
  };
}

export function uninstallWebMCP() {
  activeGeneration += 1;
  activeController?.abort();
  activeController = null;
  activeContext = null;
  activeFingerprint = '';
  activeMode = 'preview';
  activeError = null;
  activeReady = Promise.resolve();
}

export function installWebMCP(tools, { onStatus = () => {} } = {}) {
  activeTools = tools;
  exposePreviewBridge();

  const context = getModelContext();
  const nextFingerprint = fingerprint(tools);
  const execute = (name, input = {}, options = {}) => executeActiveTool(name, input, options);

  if (!context?.registerTool) {
    if (activeController) uninstallWebMCP();
    activeTools = tools;
    activeMode = 'preview';
    exposePreviewBridge();
    onStatus({ ...status(), message: 'Tool Lab preview' });
    return { mode: activeMode, toolCount: tools.length, execute, ready: activeReady };
  }

  if (
    context === activeContext
    && nextFingerprint === activeFingerprint
    && activeController
    && !activeController.signal.aborted
  ) {
    const message = activeMode === 'native'
      ? 'Native WebMCP connected'
      : activeMode === 'connecting'
        ? 'Connecting native WebMCP…'
        : 'Preview fallback active';
    onStatus({ ...status(), message });
    return { mode: activeMode, toolCount: tools.length, execute, ready: activeReady };
  }

  activeController?.abort();
  activeController = new AbortController();
  activeContext = context;
  activeFingerprint = nextFingerprint;
  activeMode = 'connecting';
  activeError = null;
  const generation = ++activeGeneration;
  const controller = activeController;

  onStatus({ ...status(), message: 'Connecting native WebMCP…' });

  activeReady = Promise.all(tools.map((tool) => Promise.resolve().then(() => (
    context.registerTool(registrationDefinition(tool), { signal: controller.signal })
  ))))
    .then(() => {
      if (generation !== activeGeneration || controller.signal.aborted) return;
      activeMode = 'native';
      onStatus({ ...status(), message: 'Native WebMCP connected' });
    })
    .catch((error) => {
      if (generation !== activeGeneration || controller.signal.aborted) return;
      controller.abort();
      activeMode = 'preview';
      activeError = error;
      console.warn('Native WebMCP registration failed; using Tool Lab preview.', error);
      onStatus({ ...status(), message: 'Preview fallback active' });
    });

  return { mode: activeMode, toolCount: tools.length, execute, ready: activeReady };
}

export const schemas = {
  empty: { type: 'object', properties: {}, additionalProperties: false },
  id: {
    type: 'string',
    minLength: 1,
    maxLength: 120,
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
    description: 'A stable workspace id returned by a read or create tool.',
  },
  shortText: { type: 'string', minLength: 1, maxLength: 160 },
  longText: { type: 'string', minLength: 1, maxLength: 4000 },
  score: { type: 'number', minimum: 0, maximum: 10 },
  confidence: { type: 'number', minimum: 0, maximum: 100 },
  weight: { type: 'number', minimum: 0, maximum: 100 },
};
