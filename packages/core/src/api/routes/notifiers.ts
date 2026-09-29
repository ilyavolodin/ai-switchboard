import type { FastifyInstance } from 'fastify';

import { sendTestNotification } from '../../services/instances.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { reasonedBody, type Reasoned } from '../contract.js';
import { registerAdminInstanceRoutes } from './instance-lifecycle.js';
import { allow } from './options.js';

export function registerNotifierRoutes(app: FastifyInstance, ctx: ApiContext): void {
  registerAdminInstanceRoutes(app, ctx, 'notifier', '/api/v1/notifiers');

  app.post<{ Params: { id: string }; Body: Reasoned }>(
    '/api/v1/notifiers/:id/test',
    allow('admin', reasonedBody),
    async (req) =>
      sendTestNotification(ctx.db, ctx.runtime, req.params.id, changeMeta(req, ctx.clock)),
  );
}
