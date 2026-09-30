import type { FastifyInstance } from 'fastify';

import {
  activityQuery,
  createSourceBody,
  reasonedBody,
  sourcePreviewBody,
  testEventBody,
  updateSourceBody,
  windowQuery,
  type ActivityQuery,
  type CreateSourceRequest,
  type Reasoned,
  type SourcePreviewRequest,
  type TestEventRequest,
  type UpdateSourceRequest,
  type WindowQuery,
} from '../../contract/index.js';
import { provisionSource } from '../../services/instances.js';
import { lastDeliveryOf, previewSource } from '../../services/source-preview.js';
import { hookUrl } from '../../services/urls.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { listActivity } from '../read/activity.js';
import { sourceDetail, sourceSummaries } from '../read/instances.js';
import { sourceStats } from '../read/stats.js';
import { registerInstanceLifecycle } from './instance-lifecycle.js';
import { allow, instanceDeps } from './options.js';

export function registerSourceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const view = (id: string) => sourceDetail(ctx, id);

  registerInstanceLifecycle<CreateSourceRequest, UpdateSourceRequest>(app, ctx, {
    kind: 'source',
    base: '/api/v1/sources',
    role: 'operator',
    list: () => sourceSummaries(ctx),
    view,
    create: {
      body: createSourceBody,
      draft: ({ typeId, name, settings, caps, enabled }) => ({
        typeId,
        name,
        settings,
        caps: { ...caps },
        enabled,
      }),
    },
    update: {
      body: updateSourceBody,
      patch: ({ name, settings, caps }) => ({
        name,
        settings,
        caps: caps ? { ...caps } : undefined,
      }),
    },
  });

  app.get<{ Params: { id: string } }>('/api/v1/sources/:id', allow('viewer'), async (req) =>
    view(req.params.id),
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/sources/:id/provision',
    allow('operator', reasonedBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const url = hookUrl(ctx.config.publicUrl, req.params.id);
      return provisionSource(instanceDeps(ctx), req.params.id, url, meta);
    },
  );

  app.post<{ Params: { id: string }; Body: TestEventRequest }>(
    '/api/v1/sources/:id/test-event',
    allow('operator', testEventBody),
    async (req) =>
      ctx.pipeline.injectTestEvent(req.params.id, req.body.type, changeMeta(req, ctx.clock)),
  );

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/sources/:id/stats',
    allow('viewer', { querystring: windowQuery }),
    async (req) => sourceStats(ctx, req.params.id, req.query.window),
  );
  app.get<{ Params: { id: string }; Querystring: ActivityQuery }>(
    '/api/v1/sources/:id/events',
    allow('viewer', { querystring: activityQuery }),
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
