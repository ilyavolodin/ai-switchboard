import type { FastifyInstance } from 'fastify';

import { applyBody, type ApplyRequest } from '../../contract/index.js';
import { applyConfiguration, exportConfiguration } from '../../services/config-io.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import { allow, applyDeps } from './options.js';

export function registerConfigRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/export', allow('operator'), async (_req, reply) => {
    const yaml = await exportConfiguration(ctx.db);
    return reply
      .type('text/yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="switchboard.yaml"')
      .send(yaml);
  });

  app.post<{ Body: ApplyRequest }>('/api/v1/apply', allow('admin', applyBody), async (req) =>
    applyConfiguration(
      applyDeps(ctx),
      req.body.yaml,
      changeMeta(req, ctx.clock),
      req.body.dryRun === true,
    ),
  );
}
