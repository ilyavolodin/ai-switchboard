import type { FastifyInstance } from 'fastify';

import { actorOf } from '../../auth/fastify.js';
import { createInstance, readDestinationMeters, updateInstance } from '../../services/instances.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  createDestinationBody,
  reasonedBody,
  updateDestinationBody,
  type CreateDestinationRequest,
  type Reasoned,
  type UpdateDestinationRequest,
  type WindowQuery,
} from '../../contract/index.js';
import { requireReason } from '../errors.js';
import { destinationDetail, destinationSummaries } from '../read/instances.js';
import { meterGauges } from '../read/meters.js';
import { meterHistory, parseWindow, usageHistory } from '../read/stats.js';
import { registerInstanceLifecycle } from './instance-lifecycle.js';
import { allow, instanceDeps } from './options.js';

export function registerDestinationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const view = (id: string) => destinationDetail(ctx, id);

  registerInstanceLifecycle(app, ctx, {
    kind: 'destination',
    base: '/api/v1/destinations',
    role: 'operator',
    view,
  });

  app.get('/api/v1/destinations', allow('viewer'), async () => destinationSummaries(ctx));
  app.get<{ Params: { id: string } }>('/api/v1/destinations/:id', allow('viewer'), async (req) =>
    view(req.params.id),
  );

  app.post<{ Body: CreateDestinationRequest }>(
    '/api/v1/destinations',
    allow('operator', createDestinationBody),
    async (req, reply) => {
      const meta = changeMeta(req, ctx.clock);
      const { typeId, name, settings, caps, targetDefaults, enabled } = req.body;
      const row = await createInstance(
        instanceDeps(ctx),
        'destination',
        { typeId, name, settings, caps: { ...caps }, targetDefaults, enabled },
        meta,
      );
      await ctx.runtime.reload('destination', row.id);
      return reply.code(201).send(await view(row.id));
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateDestinationRequest }>(
    '/api/v1/destinations/:id',
    allow('operator', updateDestinationBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      const { name, settings, caps, targetDefaults } = req.body;
      const { after } = await updateInstance(
        instanceDeps(ctx),
        'destination',
        req.params.id,
        { name, settings, caps: caps ? { ...caps } : undefined, targetDefaults },
        meta,
      );
      await ctx.runtime.reload('destination', after.id);
      return view(after.id);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/destinations/:id/meters/read',
    allow('operator', reasonedBody),
    async (req) => {
      const meta = changeMeta(req, ctx.clock);
      await readDestinationMeters(
        ctx.db,
        (id) => ctx.pipeline.readMetersNow(id),
        req.params.id,
        meta,
      );
      return meterGauges(ctx, [req.params.id]);
    },
  );

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/destinations/:id/soft-hold/clear',
    allow('operator', reasonedBody),
    async (req) => {
      const reason = requireReason(req.body);
      await ctx.pipeline.clearSoftHold(req.params.id, actorOf(req), reason);
      return view(req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/destinations/:id/meters',
    allow('viewer'),
    async (req) => meterHistory(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>(
    '/api/v1/destinations/:id/usage',
    allow('viewer'),
    async (req) => usageHistory(ctx, req.params.id, parseWindow(req.query.window, '7d')),
  );
}
