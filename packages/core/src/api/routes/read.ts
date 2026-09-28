import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import type { ApiContext } from '../context.js';
import type { ActivityQuery, CloseRunRequest, RunsQuery } from '../contract.js';
import { badRequest, notFound, requireReason } from '../errors.js';
import { eventDetail, eventExists, listActivity } from '../read/activity.js';
import { approvalHistory, approvalRules, pendingApprovals } from '../read/approvals.js';
import { board, statusStrip } from '../read/board.js';
import { listRuns, runDetail } from '../read/runs.js';
import {
  meterHistory,
  parseWindow,
  processFunnel,
  processStats,
  sourceStats,
  usageHistory,
} from '../read/stats.js';

const reasoned = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
} as const;

export function registerReadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const viewer = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };

  app.get('/api/v1/status', viewer, async () => statusStrip(ctx));
  app.get('/api/v1/board', viewer, async () => board(ctx));

  // Sources, destinations, processes: statistics -----------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/sources/:id/stats',
    viewer,
    async (req) => sourceStats(ctx, req.params.id, parseWindow(req.query.window)),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery }>(
    '/api/v1/sources/:id/events',
    viewer,
    async (req) => listActivity(ctx, { ...req.query, source: req.params.id }),
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/destinations/:id/meters',
    viewer,
    async (req) => meterHistory(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/destinations/:id/usage',
    viewer,
    async (req) => usageHistory(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/processes/:id/funnel',
    viewer,
    async (req) => processFunnel(ctx, req.params.id, parseWindow(req.query.window)),
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/processes/:id/stats',
    viewer,
    async (req) => processStats(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery }>(
    '/api/v1/processes/:id/activity',
    viewer,
    async (req) => listActivity(ctx, { ...req.query, process: req.params.id }),
  );

  // Activity, events and trace ---------------------------------------------------------------
  app.get<{ Querystring: ActivityQuery }>('/api/v1/events', viewer, async (req) =>
    listActivity(ctx, req.query),
  );
  app.get<{ Params: { id: string } }>('/api/v1/events/:id', viewer, async (req) =>
    eventDetail(ctx, req.params.id),
  );
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/v1/events/:id/replay',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      if (!(await eventExists(ctx, req.params.id))) throw notFound('Event');
      return ctx.pipeline.replay(req.params.id, actorOf(req), reason);
    },
  );
  app.get<{ Querystring: { artifact?: string } }>('/api/v1/trace', viewer, async (req) => {
    const q = req.query.artifact?.trim();
    if (!q) throw badRequest('Give an artifact id, e.g. LOL-1712 or #482.');
    return ctx.preview.traceForArtifact(q);
  });
  app.get<{ Params: { id: string } }>('/api/v1/events/:id/trace', viewer, async (req) =>
    ctx.preview.traceForEvent(req.params.id),
  );

  // Runs -------------------------------------------------------------------------------------
  app.get<{ Querystring: RunsQuery }>('/api/v1/runs', viewer, async (req) =>
    listRuns(ctx, req.query),
  );
  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', viewer, async (req) =>
    runDetail(ctx, req.params.id),
  );
  app.post<{ Params: { id: string }; Body: CloseRunRequest }>(
    '/api/v1/runs/:id/close',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      if (!['ok', 'error', 'unknown'].includes(req.body.status))
        throw badRequest('status must be ok, error or unknown');
      await ctx.pipeline.closeRun(req.params.id, req.body.status, actorOf(req), reason);
      return runDetail(ctx, req.params.id);
    },
  );

  // Approvals --------------------------------------------------------------------------------
  app.get('/api/v1/approvals', viewer, async () => pendingApprovals(ctx));
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/v1/approvals/history',
    viewer,
    async (req) => approvalHistory(ctx, req.query),
  );
  app.get('/api/v1/approvals/rules', viewer, async () => approvalRules(ctx));

  app.post<{ Params: { batchId: string }; Body: { reason: string } }>(
    '/api/v1/approvals/:batchId/approve',
    { ...operator, schema: { body: reasoned } },
    async (req) => {
      const reason = requireReason(req.body);
      return ctx.pipeline.approve(req.params.batchId, actorOf(req), reason);
    },
  );

  app.post<{ Params: { batchId: string }; Body: { reason: string } }>(
    '/api/v1/approvals/:batchId/reject',
    { ...operator, schema: { body: reasoned } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.reject(req.params.batchId, actorOf(req), reason);
      return reply.code(204).send();
    },
  );
}
