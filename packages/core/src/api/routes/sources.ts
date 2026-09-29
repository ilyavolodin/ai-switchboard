import type { FastifyInstance } from 'fastify';

import { createInstance, provisionSource, updateInstance } from '../../services/instances.js';
import { lastDeliveryOf, previewSource } from '../../services/source-preview.js';
import { actorOf } from '../../auth/fastify.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  createSourceBody,
  reasonedBody,
  sourcePreviewBody,
  testEventBody,
  type ActivityQuery,
  type CreateSourceRequest,
  type Reasoned,
  type SourcePreviewRequest,
  type TestEventRequest,
  type UpdateSourceRequest,
  type WindowQuery,
  updateSourceBody,
} from '../contract.js';
import { requireReason } from '../errors.js';
import { listActivity } from '../read/activity.js';
import { sourceDetail, sourceSummaries } from '../read/instances.js';
import { parseWindow, sourceStats } from '../read/stats.js';
import { registerInstanceLifecycle } from './instance-lifecycle.js';
import { allow, instanceDeps } from './options.js';

export function registerSourceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const view = (id: string) => sourceDetail(ctx, id);

  registerInstanceLifecycle(app, ctx, {
    kind: 'source',
    base: '/api/v1/sources',
    role: 'operator',
    view,
  });

  app.get('/api/v1/sources', allow('viewer'), async () => sourceSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/sources/:id', allow('viewer'), async (req) =>
    view(req.params.id),
  );

  app.post<{ Body: CreateSourceRequest }>(
    '/api/v1/sources',
    allow('operator', createSourceBody),
    async (req, reply) => {
      const meta = changeMeta(req, ctx.clock);
      const { typeId, name, settings, caps, enabled } = req.body;
      const row = await createInstance(
        instanceDeps(ctx),
        'source',
        { typeId, name, settings, caps: { ...caps }, enabled },
        meta,
      );
      await ctx.runtime.reload('source', row.id);
      return reply.code(201).send(await view(row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateSourceRequest }>(
    '/api/v1/sources/:id',
    allow('operator', updateSourceBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const { name, settings, caps } = req.body;
      const { after } = await updateInstance(
        instanceDeps(ctx),
        'source',
        req.params.id,
        { name, settings, caps: caps ? { ...caps } : undefined },
        meta,
      );
      await ctx.runtime.reload('source', after.id);
      return view(after.id);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/sources/:id/provision',
    allow('operator', reasonedBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const url = `${ctx.config.publicUrl}/hooks/${req.params.id}`;
      return provisionSource(ctx.db, ctx.runtime, req.params.id, url, meta);
    },
  );

  app.post<{ Params: { id: string }; Body: TestEventRequest }>(
    '/api/v1/sources/:id/test-event',
    allow('operator', testEventBody),
    async (req) => {
      const reason = requireReason(req.body);
      return ctx.pipeline.injectTestEvent(req.params.id, req.body.type, actorOf(req), reason);
    },
  );

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/sources/:id/stats',
    allow('viewer'),
    async (req) => sourceStats(ctx, req.params.id, parseWindow(req.query.window)),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery }>(
    '/api/v1/sources/:id/events',
    allow('viewer'),
    async (req) => listActivity(ctx, { ...req.query, source: req.params.id }),
  );

  // Operator only: the preview resolves secret references and a stored delivery is a sender's
  // raw body.
  app.post<{ Body: SourcePreviewRequest }>(
    '/api/v1/sources/preview',
    allow('operator', sourcePreviewBody),
    async (req) => previewSource(ctx, ctx.host, req.body),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/sources/:id/last-delivery',
    allow('operator'),
    async (req) => lastDeliveryOf(ctx, req.params.id),
  );
}
