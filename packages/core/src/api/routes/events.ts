import type { FastifyInstance } from 'fastify';

import {
  reasonedBody,
  type ActivityQuery,
  type EventIdsResponse,
  type Reasoned,
  type TraceQuery,
} from '../../contract/index.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { badRequest } from '../errors.js';
import { eventDetail, listActivity } from '../read/activity.js';
import { allow } from './options.js';

export function registerEventRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Querystring: ActivityQuery }>('/api/v1/events', allow('viewer'), async (req) =>
    listActivity(ctx, req.query),
  );
  app.get<{ Params: { id: string } }>('/api/v1/events/:id', allow('viewer'), async (req) =>
    eventDetail(ctx, req.params.id),
  );
  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/events/:id/replay',
    allow('operator', reasonedBody),
    async (req): Promise<EventIdsResponse> =>
      ctx.pipeline.replay(req.params.id, changeMeta(req, ctx.clock)),
  );
  app.get<{ Params: { id: string } }>('/api/v1/events/:id/trace', allow('viewer'), async (req) =>
    ctx.preview.traceForEvent(req.params.id),
  );
  app.get<{ Querystring: TraceQuery }>('/api/v1/trace', allow('viewer'), async (req) => {
    const q = req.query.artifact?.trim();
    if (!q) throw badRequest('Give an artifact id, e.g. LOL-1712 or #482.');
    return ctx.preview.traceForArtifact(q);
  });
}
