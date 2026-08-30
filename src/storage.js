export class WorkspacePersistenceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'WorkspacePersistenceError';
    this.code = 'WORKSPACE_PERSISTENCE_FAILED';
  }
}

export function persistWorkspace(storage, key, workspace) {
  let serialized;
  try {
    serialized = JSON.stringify(workspace);
  } catch (cause) {
    throw new WorkspacePersistenceError(
      'Could not serialize the workspace; no changes were applied.',
      { cause },
    );
  }

  try {
    storage.setItem(key, serialized);
  } catch (cause) {
    throw new WorkspacePersistenceError(
      'Could not save the workspace in this browser; no changes were applied. Check private-browsing or storage limits and retry.',
      { cause },
    );
  }
  return serialized.length;
}

export function restoreWorkspace(storage, key, { fallback, normalize }) {
  try {
    const saved = storage.getItem(key);
    return {
      workspace: normalize(saved ? JSON.parse(saved) : fallback, fallback),
      warning: null,
    };
  } catch (cause) {
    return {
      workspace: normalize(fallback, fallback),
      warning: new WorkspacePersistenceError(
        'Stored workspace data was unreadable, so Forkcast opened the built-in example.',
        { cause },
      ),
    };
  }
}

/**
 * Persist first, then return a new session snapshot. Callers only assign this
 * return value after persistence succeeds, which makes storage failure an
 * atomic no-op for workspace and undo history.
 */
export function commitWorkspaceSnapshot({
  storage,
  key,
  workspace,
  history,
}) {
  persistWorkspace(storage, key, workspace);
  return { workspace, history };
}
