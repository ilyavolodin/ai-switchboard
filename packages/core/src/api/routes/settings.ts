import type { FastifyInstance } from 'fastify';

import { getSettings, updateSettings } from '../../services/settings.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  updateSettingsBody,
  type AuditQuery,
  type UpdateSettingsRequest,
} from '../../contract/index.js';
import { about } from '../read/about.js';
import { listAudit } from '../read/audit.js';
import { allow } from './options.js';

export function registerSettingsRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/settings', allow('viewer'), async () => getSettings(ctx.db));

  app.put<{ Body: UpdateSettingsRequest }>(
    '/api/v1/settings',
    allow('admin', updateSettingsBody),
    async (req) => {
      const after = await updateSettings(ctx.db, req.body.settings, changeMeta(req, ctx.clock));
      // This replica sees the new policy at once; others within the policy's TTL.
      app.reasons.invalidate();
      return after;
    },
  );

  app.get<{ Querystring: AuditQuery }>('/api/v1/audit', allow('viewer'), async (req) =>
    listAudit(ctx, req.query),
  );

  app.get('/api/v1/about', allow('viewer'), async () => about(ctx));
}
