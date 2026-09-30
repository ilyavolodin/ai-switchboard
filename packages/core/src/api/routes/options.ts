import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

import { requireRole } from '../../auth/fastify.js';
import type { AuthUser } from '../../auth/sessions.js';
import type { Role } from '../../domain/status.js';
import type { ApplyDeps } from '../../services/config-io.js';
import { unauthenticated } from '../../services/errors.js';
import type { InstanceDeps } from '../../services/instances.js';
import type { PluginAdminDeps } from '../../services/plugin-admin.js';
import type { SecretProviderDeps } from '../../services/secret-providers.js';
import type { ApiContext } from '../context.js';

export interface RouteSchemas {
  body?: object;
  querystring?: object;
}

/**
 * Route options: the role a route needs and its JSON Schemas. The second argument is a body schema
 * (`allow('operator', reasonedBody)`) or both kinds (`allow('viewer', { querystring: runsQuery })`).
 */
export function allow(
  role: Role,
  schemas?: { readonly type: 'object' } | RouteSchemas,
): { preHandler: preHandlerHookHandler; schema?: RouteSchemas } {
  const preHandler = requireRole(role);
  if (!schemas) return { preHandler };
  return { preHandler, schema: 'type' in schemas ? { body: schemas } : schemas };
}

/** The signed-in user; a 401 for a route reached without one. */
export function authedUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthenticated('Sign in to continue.');
  return req.user;
}

export function instanceDeps(ctx: ApiContext): InstanceDeps {
  return { db: ctx.db, runtime: ctx.runtime, host: ctx.host };
}

export function applyDeps(ctx: ApiContext): ApplyDeps {
  return { db: ctx.db, runtime: ctx.runtime, clock: ctx.clock, host: ctx.host };
}

export function pluginAdminDeps(ctx: ApiContext): PluginAdminDeps {
  return {
    db: ctx.db,
    config: ctx.config,
    host: ctx.host,
    runNpm: ctx.runNpm,
    registryFetch: ctx.registryFetch,
  };
}

export function secretProviderDeps(ctx: ApiContext): SecretProviderDeps {
  return { db: ctx.db, runtime: ctx.runtime, host: ctx.host };
}
