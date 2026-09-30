import type { preHandlerHookHandler } from 'fastify';

import { requireRole } from '../../auth/fastify.js';
import type { Role } from '../../domain/status.js';
import type { InstanceDeps } from '../../services/instances.js';
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

export function instanceDeps(ctx: ApiContext): InstanceDeps {
  return {
    db: ctx.db,
    runtime: ctx.runtime,
    probe: (typeId, settings, id, name) => ctx.host.buildPreviewSource(typeId, settings, id, name),
  };
}
