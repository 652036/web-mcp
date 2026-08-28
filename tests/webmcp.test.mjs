import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/webmcp.js';

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
