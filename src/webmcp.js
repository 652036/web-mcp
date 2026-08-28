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
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new RangeError(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new RangeError(`${path} allows at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((item, index) => validateInput(schema.items, item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw new TypeError(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !(key in properties));
      if (unknown) throw new TypeError(`${path}.${unknown} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validateInput(child, value[key], `${path}.${key}`);
    }
  }
  return true;
}

export function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'string' ? { text: value } : value,
  };
}

let activeController = null;
let activeTools = [];

export function getModelContext() {
  return globalThis.document?.modelContext ?? globalThis.navigator?.modelContext ?? null;
}

export function installWebMCP(tools, { onStatus = () => {} } = {}) {
  activeController?.abort();
  activeController = new AbortController();
  activeTools = tools;

  const execute = async (name, input = {}) => {
    const tool = activeTools.find((item) => item.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validateInput(tool.inputSchema ?? { type: 'object' }, input);
    const result = await tool.execute(input, { signal: activeController.signal });
    return result;
  };

  globalThis.__forkcastWebMCP = {
    listTools: () => activeTools.map(({ execute: _execute, ...tool }) => tool),
    executeTool: execute,
    status: () => ({ mode: getModelContext() ? 'native' : 'preview', toolCount: activeTools.length }),
  };

  const context = getModelContext();
  if (!context?.registerTool) {
    onStatus({ mode: 'preview', toolCount: tools.length, message: 'Tool Lab preview' });
    return { mode: 'preview', toolCount: tools.length, execute };
  }

  try {
    for (const tool of tools) {
      const definition = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: async (input, metadata = {}) => {
          validateInput(tool.inputSchema ?? { type: 'object' }, input ?? {});
          const result = await tool.execute(input ?? {}, {
            signal: metadata.signal ?? activeController.signal,
          });
          return textResult(result);
        },
      };
      context.registerTool(definition, { signal: activeController.signal });
    }
    onStatus({ mode: 'native', toolCount: tools.length, message: 'Native WebMCP connected' });
    return { mode: 'native', toolCount: tools.length, execute };
  } catch (error) {
    console.warn('Native WebMCP registration failed; using Tool Lab preview.', error);
    onStatus({ mode: 'preview', toolCount: tools.length, message: 'Preview fallback active', error });
    return { mode: 'preview', toolCount: tools.length, execute };
  }
}

export const schemas = {
  empty: { type: 'object', properties: {}, additionalProperties: false },
  id: { type: 'string', minLength: 1, maxLength: 120 },
  shortText: { type: 'string', minLength: 1, maxLength: 160 },
  longText: { type: 'string', minLength: 1, maxLength: 4000 },
  score: { type: 'number', minimum: 0, maximum: 10 },
  confidence: { type: 'number', minimum: 0, maximum: 100 },
  weight: { type: 'number', minimum: 0, maximum: 1000 },
};
