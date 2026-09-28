import { secretPaths } from '@ai-switchboard/sdk';
import type { FastifyInstance } from 'fastify';

import { requireRole } from '../../auth/fastify.js';
import { isSecretRef } from '../../secrets/refs.js';
import { isUuid } from '../../services/pipeline/errors.js';
import {
  lastDelivery,
  previewSourceDelivery,
  sourceForPreview,
} from '../../services/source-preview.js';
import type { ApiContext } from '../context.js';
import type { SourcePreviewRequest, SourcePreviewResponse } from '../contract.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { validateSettings } from './instances.js';

const stringMap = { type: 'object', additionalProperties: { type: 'string' } } as const;

const previewBody = {
  type: 'object',
  required: ['typeId', 'settings', 'request'],
  properties: {
    typeId: { type: 'string', minLength: 1 },
    settings: { type: 'object' },
    sourceId: { type: 'string' },
    request: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', maxLength: 1_048_576 },
        headers: stringMap,
        query: stringMap,
      },
    },
  },
} as const;

function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    cur =
      cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
  }
  return cur;
}

function setPath(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = value;
  for (const key of keys.slice(0, -1)) {
    const child = cur[key];
    if (child === null || typeof child !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last !== undefined) cur[last] = next;
}

function emptyPreview(errors: string[]): SourcePreviewResponse {
  return { events: [], errors, notes: [], declaredTypes: [] };
}

/**
 * The sample-delivery preview for push sources (Add source and Source › Settings) and the
 * last stored delivery to use as a sample. Operator only: the preview resolves secret
 * references and a stored delivery is a sender's raw body.
 */
export function registerSourcePreviewRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const operator = { preHandler: requireRole('operator') };

  app.post<{ Body: SourcePreviewRequest }>(
    '/api/v1/sources/preview',
    { ...operator, schema: { body: previewBody } },
    async (req) => {
      const { typeId, sourceId, request } = req.body;
      const entry = ctx.runtime.sourceType(typeId);
      if (!entry) throw notFound(`Source type ${typeId}`);
      if (entry.type.mode === 'pull') {
        throw unprocessable(
          `${entry.type.displayName} sources are polled, not pushed: there is no delivery to preview.`,
        );
      }
      const draft = structuredClone(req.body.settings);
      let name = `${entry.type.displayName} preview`;
      if (sourceId !== undefined) {
        const stored = isUuid(sourceId) ? await sourceForPreview(ctx, sourceId) : null;
        if (!stored) throw notFound(`Source ${sourceId}`);
        if (stored.typeId !== typeId) {
          throw unprocessable(`Source ${stored.name} is a ${stored.typeId} source, not ${typeId}.`);
        }
        name = stored.name;
        // A secret field left empty keeps the stored reference, as a save would.
        for (const path of secretPaths(entry.type.settingsSchema)) {
          const given = getPath(draft, path);
          const kept = getPath(stored.settings, path);
          if ((given === undefined || given === '') && isSecretRef(kept))
            setPath(draft, path, kept);
        }
      }
      let settings: Record<string, unknown>;
      try {
        settings = validateSettings(entry.type.settingsSchema, draft);
      } catch (err) {
        if (err instanceof HttpError) {
          // "must match \"then\" schema" only repeats the branch's own messages.
          const details = (err.details ?? [err.message]).filter(
            (d) => !/must match "(then|else)" schema$/.test(d),
          );
          return emptyPreview(details.map((d) => `Settings: ${d.replace(/^\(root\) /, '')}`));
        }
        throw err;
      }
      return previewSourceDelivery(ctx, ctx.host, {
        typeId,
        settings,
        sourceId,
        name,
        sample: request,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/sources/:id/last-delivery',
    operator,
    async (req) => {
      const { id } = req.params;
      if (!isUuid(id) || !(await sourceForPreview(ctx, id))) throw notFound(`Source ${id}`);
      const last = await lastDelivery(ctx, id);
      if (!last) throw new HttpError(404, 'not_found', 'This source has no stored delivery yet.');
      return last;
    },
  );
}
