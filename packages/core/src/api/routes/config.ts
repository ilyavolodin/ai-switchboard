import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import { applyConfiguration, exportConfiguration } from '../../services/config-io.js';
import type { ApiContext } from '../context.js';
import type { ApplyRequest } from '../contract.js';
import { HttpError, requireReason } from '../errors.js';
import { validateSettings } from './instances.js';
import { validateProcessDocument } from './processes.js';

export function registerConfigRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/v1/export', { preHandler: requireRole('operator') }, async (_req, reply) => {
    const yaml = await exportConfiguration(ctx.db);
    return reply
      .type('text/yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="switchboard.yaml"')
      .send(yaml);
  });

  app.post<{ Body: ApplyRequest }>(
    '/api/v1/apply',
    {
      preHandler: requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          required: ['yaml', 'reason'],
          properties: {
            yaml: { type: 'string' },
            dryRun: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const reason = requireReason(req.body);
      const typeSchema = (
        kind: 'source' | 'executor' | 'notifier' | 'secret_provider',
        typeId: string,
      ) => {
        switch (kind) {
          case 'source':
            return ctx.runtime.sourceType(typeId)?.type.settingsSchema;
          case 'executor':
            return ctx.runtime.executorType(typeId)?.type.settingsSchema;
          case 'notifier':
            return ctx.runtime.notifierType(typeId)?.type.settingsSchema;
          case 'secret_provider':
            return ctx.runtime.secretProviderType(typeId)?.type.settingsSchema;
        }
      };
      const result = await applyConfiguration(ctx.db, req.body.yaml, {
        actor: actorOf(req),
        reason,
        now: ctx.clock.now(),
        dryRun: req.body.dryRun === true,
        validateSettings: (kind, typeId, settings) => {
          const schema = typeSchema(kind, typeId);
          if (!schema) return undefined;
          try {
            validateSettings(schema, settings);
            return [];
          } catch (err) {
            return err instanceof HttpError ? (err.details ?? [err.message]) : [String(err)];
          }
        },
        validateProcess: async (doc, tx) => {
          try {
            await validateProcessDocument(ctx, doc, tx);
            return [];
          } catch (err) {
            return err instanceof HttpError ? (err.details ?? [err.message]) : [String(err)];
          }
        },
      });
      if (!result.dryRun && result.errors.length === 0) await ctx.host.instantiateAll();
      return result;
    },
  );
}
