import { ID_PATTERN_SOURCE } from './engine.js';

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

/** name -> { controller, fingerprint, ready } for every natively registered tool. */
const registry = new Map();
let activeContext = null;
let activeGeneration = 0;
let activeMode = 'preview';
let activeError = null;
let activeReady = Promise.resolve();
let activeTools = [];
let inFlight = 0;
let pendingInstall = null;
let previewReason = null;

export function getModelContext() {
  return globalThis.document?.modelContext ?? globalThis.navigator?.modelContext ?? null;
}

/** WebMCP tools belong to the top-level document; an embedded frame never registers natively. */
export function isEmbedded() {
  try {
    return globalThis.top !== undefined && globalThis.top !== globalThis.self;
  } catch {
    return true;
  }
}

function fingerprint({ name, title, description, inputSchema, annotations }) {
  return JSON.stringify({ name, title, description, inputSchema, annotations });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? new DOMException('The tool call was aborted.', 'AbortError');
}

function flushPendingInstall() {
  if (inFlight > 0 || !pendingInstall) return;
  const { tools, onStatus } = pendingInstall;
  pendingInstall = null;
  try {
    reconcile(tools, onStatus);
  } catch (error) {
    console.warn('Deferred WebMCP refresh failed.', error);
  }
}

/**
 * Registry changes requested while a tool call is executing are applied only
 * after the call has returned, on a fresh task, so a tool can never abort its
 * own in-progress invocation through the state change it just made.
 */
async function executeActiveTool(name, input = {}, { signal } = {}) {
  const tool = activeTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown or unavailable tool: ${name}`);
  throwIfAborted(signal);
  validateInput(tool.inputSchema ?? schemas.empty, input);
  inFlight += 1;
  try {
    const result = await tool.execute(input, { signal });
    throwIfAborted(signal);
    return result;
  } finally {
    inFlight -= 1;
    if (inFlight === 0 && pendingInstall) setTimeout(flushPendingInstall, 0);
  }
}

function publicTools() {
  return activeTools.map(({ execute: _execute, ...tool }) => tool);
}

function status() {
  return {
    mode: activeMode,
    toolCount: activeTools.length,
    registeredCount: registry.size,
    inFlight,
    reason: activeMode === 'preview' ? previewReason : null,
    error: activeError ? errorMessage(activeError) : null,
  };
}

function statusMessage() {
  if (activeMode === 'native') return 'Native WebMCP connected';
  if (activeMode === 'connecting') return 'Connecting native WebMCP…';
  return activeError ? 'Preview fallback active' : 'Tool Lab preview';
}

function exposePreviewBridge() {
  globalThis.__forkcastWebMCP = {
    listTools: publicTools,
    executeTool: (name, input = {}, options = {}) => executeActiveTool(name, input, options),
    status,
    ready: () => activeReady,
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

function clearRegistry() {
  for (const entry of registry.values()) entry.controller.abort();
  registry.clear();
}

function enterPreview(onStatus, { error = null, reason = 'unsupported' } = {}) {
  clearRegistry();
  activeMode = 'preview';
  activeError = error;
  previewReason = error ? 'registration-failed' : reason;
  activeReady = Promise.resolve();
  onStatus({ ...status(), message: statusMessage() });
}

/**
 * Diff the desired tool set against the native registry: abort only tools
 * that disappeared or changed shape, register only tools that are new or
 * changed, and leave content-equivalent registrations untouched.
 */
function reconcile(tools, onStatus) {
  activeTools = tools;
  exposePreviewBridge();
  const context = getModelContext();

  if (isEmbedded()) {
    enterPreview(onStatus, { reason: 'embedded' });
    return;
  }
  if (!context?.registerTool) {
    enterPreview(onStatus, { reason: 'unsupported' });
    return;
  }
  if (context !== activeContext) {
    clearRegistry();
    activeContext = context;
  }

  const desired = new Set(tools.map((tool) => tool.name));
  for (const [name, entry] of registry) {
    if (desired.has(name)) continue;
    entry.controller.abort();
    registry.delete(name);
  }

  let added = 0;
  for (const tool of tools) {
    const nextFingerprint = fingerprint(tool);
    const existing = registry.get(tool.name);
    if (existing && existing.fingerprint === nextFingerprint) continue;
    existing?.controller.abort();
    const controller = new AbortController();
    const ready = Promise.resolve()
      .then(() => context.registerTool(registrationDefinition(tool), { signal: controller.signal }))
      .catch((error) => {
        // A registration that was intentionally aborted (removed or replaced)
        // is not a failure of the remaining registry.
        if (controller.signal.aborted) return;
        throw error;
      });
    registry.set(tool.name, { controller, fingerprint: nextFingerprint, ready });
    added += 1;
  }

  const generation = ++activeGeneration;
  if (added) {
    activeMode = 'connecting';
    activeError = null;
    onStatus({ ...status(), message: statusMessage() });
  }
  activeReady = Promise.all([...registry.values()].map((entry) => entry.ready))
    .then(() => {
      if (generation !== activeGeneration) return;
      const changed = activeMode !== 'native';
      activeMode = 'native';
      if (changed || added) onStatus({ ...status(), message: statusMessage() });
    })
    .catch((error) => {
      if (generation !== activeGeneration) return;
      console.warn('Native WebMCP registration failed; using Tool Lab preview.', error);
      enterPreview(onStatus, { error });
    });
  if (!added) onStatus({ ...status(), message: statusMessage() });
}

export function uninstallWebMCP() {
  activeGeneration += 1;
  pendingInstall = null;
  clearRegistry();
  activeContext = null;
  activeMode = 'preview';
  activeError = null;
  previewReason = null;
  activeReady = Promise.resolve();
}

export function installWebMCP(tools, { onStatus = () => {} } = {}) {
  activeTools = tools;
  exposePreviewBridge();
  const execute = (name, input = {}, options = {}) => executeActiveTool(name, input, options);

  if (inFlight > 0) {
    pendingInstall = { tools, onStatus };
    onStatus({ ...status(), message: statusMessage() });
  } else {
    reconcile(tools, onStatus);
  }
  return { mode: activeMode, toolCount: tools.length, execute, ready: activeReady };
}

export const schemas = {
  empty: { type: 'object', properties: {}, additionalProperties: false },
  id: {
    type: 'string',
    minLength: 1,
    maxLength: 120,
    pattern: ID_PATTERN_SOURCE,
    description: 'A stable workspace id returned by a read or create tool.',
  },
  shortText: { type: 'string', minLength: 1, maxLength: 160 },
  longText: { type: 'string', minLength: 1, maxLength: 4000 },
  score: { type: 'number', minimum: 0, maximum: 10 },
  confidence: { type: 'number', minimum: 0, maximum: 100 },
  weight: { type: 'number', minimum: 0, maximum: 100 },
};
