import test from 'node:test';
import assert from 'node:assert/strict';
import { getExample } from '../src/data.js';
import { normalizeWorkspace } from '../src/engine.js';
import {
  commitWorkspaceSnapshot,
  restoreWorkspace,
  WorkspacePersistenceError,
} from '../src/storage.js';

test('persistence failure is diagnostic and leaves workspace and history untouched', () => {
  const current = getExample('launch');
  const history = [];
  const next = structuredClone(current);
  next.brief.title = 'Should not commit';
  const storage = {
    setItem() {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    },
  };

  assert.throws(
    () => commitWorkspaceSnapshot({
      storage,
      key: 'workspace',
      workspace: next,
      history: [...history, { workspace: current, actor: 'agent', message: 'change' }],
    }),
    (error) => error instanceof WorkspacePersistenceError
      && error.code === 'WORKSPACE_PERSISTENCE_FAILED'
      && /no changes were applied/i.test(error.message),
  );
  assert.equal(current.brief.title, 'Launch Atlas Notes');
  assert.deepEqual(history, []);
});

test('restore hydrates saved JSON and falls back with a diagnostic on corruption', () => {
  const fallback = getExample('launch');
  const valid = restoreWorkspace({
    getItem: () => JSON.stringify({ ...fallback, brief: { ...fallback.brief, title: 'Restored' } }),
  }, 'workspace', { fallback, normalize: normalizeWorkspace });
  assert.equal(valid.workspace.brief.title, 'Restored');
  assert.equal(valid.warning, null);

  const corrupt = restoreWorkspace({ getItem: () => '{not json' }, 'workspace', {
    fallback,
    normalize: normalizeWorkspace,
  });
  assert.equal(corrupt.workspace.brief.title, fallback.brief.title);
  assert.ok(corrupt.warning instanceof WorkspacePersistenceError);
});
