import type { FastifyRequest } from 'fastify';

import { actorOf } from '../auth/fastify.js';
import type { Clock } from '../clock.js';
import type { ChangeMeta } from '../services/audit.js';
import { requireReason } from './errors.js';

/** The actor, the required reason and the time of a mutating request, for the service call. */
export function changeMeta(req: FastifyRequest, clock: Clock): ChangeMeta {
  return { actor: actorOf(req), reason: requireReason(req.body), now: clock.now() };
}
