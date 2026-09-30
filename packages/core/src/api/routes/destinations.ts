import type { FastifyInstance } from 'fastify';

import {
  createDestinationBody,
  reasonedBody,
  updateDestinationBody,
  windowQuery,
  type CreateDestinationRequest,
  type Reasoned,
  type UpdateDestinationRequest,
  type WindowQuery,
} from '../../contract/index.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { destinationDetail, destinationSummaries } from '../read/instances.js';
import { meterGauges } from '../read/meters.js';
import { meterHistory, usageHistory } from '../read/stats.js';
import { registerInstanceLifecycle } from './instance-lifecycle.js';
import { allow } from './options.js';

export function registerDestinationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const view = (id: string) => destinationDetail(ctx, id);

  registerInstanceLifecycle<CreateDestinationRequest, UpdateDestinationRequest>(app, ctx, {
    kind: 'destination',
    base: '/api/v1/destinations',
    role: 'operator',
    list: () => destinationSummaries(ctx),
    view,
    create: {
      body: createDestinationBody,
      draft: ({ typeId, name, settings, caps, targetDefaults, enabled }) => ({
        typeId,
        name,
        settings,
        caps: { ...caps },
        targetDefaults,
        enabled,
      }),
    },
    update: {
      body: updateDestinationBody,
      patch: ({ name, settings, caps, targetDefaults }) => ({
        name,
        settings,
        caps: caps ? { ...caps } : undefined,
        targetDefaults,
      }),
    },
  });

  app.get<{ Params: { id: string } }>('/api/v1/destinations/:id', allow('viewer'), async (req) =>
    view(req.params.id),
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/destinations/:id/meters/read',
    allow('operator', reasonedBody),
    async (req) => {
      await ctx.pipeline.readMetersNow(req.params.id, changeMeta(req, ctx.clock));
      return meterGauges(ctx, [req.params.id]);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/destinations/:id/soft-hold/clear',
    allow('operator', reasonedBody),
    async (req) => {
      await ctx.pipeline.clearSoftHold(req.params.id, changeMeta(req, ctx.clock));
      return view(req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/destinations/:id/meters',
    allow('viewer', { querystring: windowQuery }),
    async (req) => meterHistory(ctx, req.params.id, req.query.window),
  );
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/destinations/:id/usage',
    allow('viewer', { querystring: windowQuery }),
    async (req) => usageHistory(ctx, req.params.id, req.query.window),
  );
}
