import type { FastifyInstance } from 'fastify';

import { applyConfiguration, exportConfiguration } from '../../services/config-io.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { applyBody, type ApplyRequest } from '../../contract/index.js';
import { allow, instanceDeps } from './options.js';

export function registerConfigRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/export', allow('operator'), async (_req, reply) => {
    const yaml = await exportConfiguration(ctx.db);
    return reply
      .type('text/yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="switchboard.yaml"')
      .send(yaml);
  });

  app.post<{ Body: ApplyRequest }>('/api/v1/apply', allow('admin', applyBody), async (req) => {
    const { actor, reason, now } = changeMeta(req, ctx.clock);
    const result = await applyConfiguration(
      { ...instanceDeps(ctx), clock: ctx.clock },
      req.body.yaml,
      { actor, reason, now, dryRun: req.body.dryRun === true },
    );
    if (!result.dryRun && result.errors.length === 0) await ctx.host.instantiateAll();
    return result;
  });
}
