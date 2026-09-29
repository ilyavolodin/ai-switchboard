import type { FastifyInstance } from 'fastify';

import { actorOf } from '../../auth/fastify.js';
import type { ApiContext } from '../context.js';
import { closeRunBody, type CloseRunRequest, type RunsQuery } from '../contract.js';
import { requireReason } from '../errors.js';
import { listRuns, runDetail } from '../read/runs.js';
import { allow } from './options.js';

export function registerRunRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Querystring: RunsQuery }>('/api/v1/runs', allow('viewer'), async (req) =>
    listRuns(ctx, req.query),
  );
  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', allow('viewer'), async (req) =>
    runDetail(ctx, req.params.id),
  );
  app.post<{ Params: { id: string }; Body: CloseRunRequest }>(
    '/api/v1/runs/:id/close',
    allow('operator', closeRunBody),
    async (req) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.closeRun(req.params.id, req.body.status, actorOf(req), reason);
      return runDetail(ctx, req.params.id);
    },
  );
}
