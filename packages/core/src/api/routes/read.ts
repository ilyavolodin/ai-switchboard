import { and, desc, eq, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import { approvals, batches, events, processes } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import type {
  ActivityQuery,
  ApprovalHistoryItem,
  ApprovalItem,
  ApprovalRulesResponse,
  CloseRunRequest,
  Page,
  RunsQuery,
} from '../contract.js';
import { badRequest, notFound, requireReason } from '../errors.js';
import { eventDetail, listActivity } from '../read/activity.js';
import { board, statusStrip } from '../read/board.js';
import { decodeCursor, encodeCursor, pageLimit } from '../read/paging.js';
import { batchArtifacts, listRuns, runDetail } from '../read/runs.js';
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

  // Sources, executors, processes: statistics -----------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/sources/:id/stats',
    viewer,
    async (req) => sourceStats(ctx, req.params.id, parseWindow(req.query.window)),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery & { type?: string } }>(
    '/api/v1/sources/:id/events',
    viewer,
    async (req) => {
      const page = await listActivity(ctx, { ...req.query, source: req.params.id });
      const type = req.query.type;
      return type ? { ...page, items: page.items.filter((i) => i.type === type) } : page;
    },
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/executors/:id/meters',
    viewer,
    async (req) => meterHistory(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/v1/executors/:id/usage',
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
      const [row] = await ctx.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, req.params.id));
      if (!row) throw notFound('Event');
      return ctx.pipeline.replay(row.id, actorOf(req), reason);
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
  const approvalItems = async (
    rows: (typeof approvals.$inferSelect)[],
  ): Promise<ApprovalItem[]> => {
    const arts = await batchArtifacts(
      ctx,
      rows.map((r) => r.batchId),
    );
    const procs = await ctx.db.select({ id: processes.id, name: processes.name }).from(processes);
    const kinds =
      rows.length > 0
        ? await ctx.db.select({ id: batches.id, kind: batches.kind }).from(batches)
        : [];
    return rows.map((r) => ({
      batchId: r.batchId,
      process: {
        id: r.processId,
        name: procs.find((p) => p.id === r.processId)?.name ?? '(deleted process)',
      },
      rule: r.rule,
      requestedAt: r.requestedAt.toISOString(),
      artifacts: arts.get(r.batchId)?.artifacts ?? [],
      eventCount: arts.get(r.batchId)?.count ?? 0,
      kind: kinds.find((k) => k.id === r.batchId)?.kind ?? 'event',
      input: r.input,
    }));
  };

  app.get('/api/v1/approvals', viewer, async () => {
    const rows = await ctx.db
      .select()
      .from(approvals)
      .where(isNull(approvals.decision))
      .orderBy(approvals.requestedAt);
    return approvalItems(rows);
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/v1/approvals/history',
    viewer,
    async (req): Promise<Page<ApprovalHistoryItem>> => {
      const limit = pageLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor);
      const where: SQL[] = [isNotNull(approvals.decision)];
      if (cursor) where.push(lt(approvals.decidedAt, new Date(cursor.t)));
      const rows = await ctx.db
        .select()
        .from(approvals)
        .where(and(...where))
        .orderBy(desc(approvals.decidedAt))
        .limit(limit + 1);
      const items = await approvalItems(rows.slice(0, limit));
      const last = rows[limit - 1];
      return {
        items: items.map((item, i) => {
          const r = rows[i];
          return {
            ...item,
            decision: r?.decision ?? 'rejected',
            decidedBy: r?.decidedBy ?? '',
            decidedAt: r?.decidedAt?.toISOString() ?? '',
            reason: r?.reason ?? '',
          };
        }),
        nextCursor:
          rows.length > limit && last?.decidedAt
            ? encodeCursor({ t: last.decidedAt.toISOString() })
            : null,
      };
    },
  );

  app.get('/api/v1/approvals/rules', viewer, async (): Promise<ApprovalRulesResponse> => {
    const procs = await ctx.db
      .select({ id: processes.id, name: processes.name, document: processes.document })
      .from(processes);
    return {
      processes: procs
        .filter((p) => p.document.gates.approval !== 'none')
        .map((p) => ({ id: p.id, name: p.name, rule: p.document.gates.approval })),
    };
  });

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
