/**
 * The REST API contract (`/api/v1`) between the core, the UI and the CLI: the DTOs, the request
 * body schemas that sit next to their types, and `ApiRoutes`, which maps every route to them.
 * Layer-neutral and browser-safe: routes, services and the UI import it, and it imports only pure
 * modules (`domain/`, `auth/password-policy.ts`).
 */
export * from './common.js';
export * from './schema.js';
export * from './auth.js';
export * from './board.js';
export * from './sources.js';
export * from './destinations.js';
export * from './processes.js';
export * from './events.js';
export * from './runs.js';
export * from './approvals.js';
export * from './plugins.js';
export * from './instances.js';
export * from './admin.js';
export type * from './routes.js';
