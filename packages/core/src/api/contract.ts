/**
 * The REST API contract (`/api/v1`) between the core, the UI and the CLI: the DTOs, the request
 * body schemas that sit next to their types, and `ApiRoutes`, which maps every route to them.
 */
export * from './contract/common.js';
export * from './contract/schema.js';
export * from './contract/auth.js';
export * from './contract/board.js';
export * from './contract/sources.js';
export * from './contract/destinations.js';
export * from './contract/processes.js';
export * from './contract/events.js';
export * from './contract/runs.js';
export * from './contract/approvals.js';
export * from './contract/plugins.js';
export * from './contract/instances.js';
export * from './contract/admin.js';
export type * from './contract/routes.js';
