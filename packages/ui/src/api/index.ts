/**
 * The UI's API layer: `apiFetch`, query keys and one TanStack Query hook per endpoint in
 * docs/api.md. Components import hooks from here and never call `fetch` directly.
 */
export * from './client.js';
export * from './keys.js';
export * from './mutation.js';
export * from './hooks/auth.js';
export * from './hooks/board.js';
export * from './hooks/sources.js';
export * from './hooks/executors.js';
export * from './hooks/processes.js';
export * from './hooks/activity.js';
export * from './hooks/approvals.js';
export * from './hooks/plugins.js';
export * from './hooks/instances.js';
export * from './hooks/secrets.js';
export * from './hooks/settings.js';
