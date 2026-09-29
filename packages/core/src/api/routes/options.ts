import type { preHandlerHookHandler } from 'fastify';

import { requireRole } from '../../auth/fastify.js';
import type { Role } from '../../domain/status.js';
import type { InstanceDeps } from '../../services/instances.js';
import type { ApiContext } from '../context.js';

/** Route options: the role a route needs and, for a route with a body, its JSON Schema. */
export function allow(
  role: Role,
  body?: object,
): { preHandler: preHandlerHookHandler; schema?: { body: object } } {
  return body
    ? { preHandler: requireRole(role), schema: { body } }
    : { preHandler: requireRole(role) };
}

export function instanceDeps(ctx: ApiContext): InstanceDeps {
  return {
    db: ctx.db,
    runtime: ctx.runtime,
    probe: (typeId, settings, id, name) => ctx.host.buildPreviewSource(typeId, settings, id, name),
  };
}
