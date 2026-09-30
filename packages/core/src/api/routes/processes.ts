import type { FastifyInstance } from 'fastify';

import {
  createProcessFrom,
  deleteProcess,
  restoreProcessVersion,
  setProcessEnabled,
  updateProcess,
} from '../../services/processes.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  createProcessBody,
  cronPreviewBody,
  enableBody,
  filterPreviewBody,
  inputPreviewBody,
  reasonedBody,
  runNowBody,
  updateProcessBody,
  type ActivityQuery,
  type CreateProcessRequest,
  type CronPreviewRequest,
  type EnableRequest,
  type FilterPreviewRequest,
  type InputPreviewRequest,
  type LimitQuery,
  type Reasoned,
  type RunNowRequest,
  type RunNowResponse,
  type UpdateProcessRequest,
  type WindowQuery,
} from '../../contract/index.js';
import { listActivity } from '../read/activity.js';
import {
  processDetail,
  processSummaries,
  processVersion,
  processVersionList,
  recentBatches,
} from '../read/processes.js';
import { parseWindow, processFunnel, processStats } from '../read/stats.js';
import { allow } from './options.js';

export function registerProcessRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const view = (id: string) => processDetail(ctx, id);

  app.get('/api/v1/processes', allow('viewer'), async () => processSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/processes/:id', allow('viewer'), async (req) =>
    view(req.params.id),
  );

  app.post<{ Body: CreateProcessRequest }>(
    '/api/v1/processes',
    allow('operator', createProcessBody),
    async (req, reply) => {
      const meta = changeMeta(req, ctx.clock);
      const id = await createProcessFrom(ctx, req.body.document, meta);
      return reply.code(201).send(await view(id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateProcessRequest }>(
    '/api/v1/processes/:id',
    allow('operator', updateProcessBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      await updateProcess(ctx, req.params.id, req.body.document, req.body.expectedVersion, meta);
      return view(req.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableRequest }>(
    '/api/v1/processes/:id/enable',
    allow('operator', enableBody),
    async (req) => {
      await setProcessEnabled(ctx.db, req.params.id, req.body.enabled, changeMeta(req, ctx.clock));
      return view(req.params.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/processes/:id',
    allow('operator'),
    async (req, reply) => {
      const deleted = await deleteProcess(ctx.db, req.params.id, changeMeta(req, ctx.clock));
      req.log.info(
        {
          process_id: req.params.id,
          dropped_batches: deleted.droppedBatches,
          withdrawn_approvals: deleted.withdrawnApprovals,
        },
        'process deleted',
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: RunNowRequest }>(
    '/api/v1/processes/:id/run',
    allow('operator', runNowBody),
    async (req): Promise<RunNowResponse> =>
      ctx.pipeline.runNow(
        req.params.id,
        {
          ...(req.body.dryRun !== undefined ? { dryRun: req.body.dryRun } : {}),
          ...(req.body.batchId !== undefined ? { batchId: req.body.batchId } : {}),
        },
        changeMeta(req, ctx.clock),
      ),
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/processes/:id/breaker/reset',
    allow('operator', reasonedBody),
    async (req) => {
      await ctx.pipeline.resetBreaker(req.params.id, changeMeta(req, ctx.clock));
      return view(req.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/processes/:id/versions',
    allow('viewer'),
    async (req) => processVersionList(ctx, req.params.id),
  );
  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/processes/:id/versions/:version',
    allow('viewer'),
    async (req) => processVersion(ctx, req.params.id, req.params.version),
  );
  app.post<{ Params: { id: string; version: string }; Body: Reasoned }>(
    '/api/v1/processes/:id/versions/:version/restore',
    allow('operator', reasonedBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      await restoreProcessVersion(ctx, req.params.id, req.params.version, meta);
      return view(req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: LimitQuery }>(
    '/api/v1/processes/:id/batches',
    allow('viewer'),
    async (req) => recentBatches(ctx, req.params.id, req.query.limit),
  );
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/processes/:id/funnel',
    allow('viewer'),
    async (req) => processFunnel(ctx, req.params.id, parseWindow(req.query.window)),
  );
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/processes/:id/stats',
    allow('viewer'),
    async (req) => processStats(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery }>(
    '/api/v1/processes/:id/activity',
    allow('viewer'),
    async (req) => listActivity(ctx, { ...req.query, process: req.params.id }),
  );

  app.post<{ Body: FilterPreviewRequest }>(
    '/api/v1/processes/preview/filter',
    allow('viewer', filterPreviewBody),
    async (req) => ctx.preview.filterPreview(req.body),
  );
  app.post<{ Body: InputPreviewRequest }>(
    '/api/v1/processes/preview/input',
    allow('viewer', inputPreviewBody),
    async (req) => ctx.preview.inputPreview(req.body),
  );
  app.post<{ Body: CronPreviewRequest }>(
    '/api/v1/processes/preview/cron',
    allow('viewer', cronPreviewBody),
    (req) => ctx.preview.cronPreview(req.body),
  );
}
