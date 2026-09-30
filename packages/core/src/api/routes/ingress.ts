import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RawRequest } from '@ai-switchboard/sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { databaseReachable } from '../../services/health.js';
import type { IngressOutcome } from '../../services/pipeline/outcomes.js';
import { isUuid } from '../../util/uuid.js';
import type { ApiContext } from '../context.js';

/** The exact bytes and lower-cased headers of an inbound request. */
export function toRawRequest(req: FastifyRequest, receivedAt: Date): RawRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
    query[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(',') : undefined;
  }
  const body = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : '');
  return {
    method: req.method,
    path: req.url.split('?')[0] ?? req.url,
    headers,
    query,
    body,
    receivedAt: receivedAt.toISOString(),
    remoteAddress: req.ip,
  };
}

/** 401 (rejected) and the other refusals carry no body, so a sender learns nothing from them. */
export const INGRESS_STATUS: Readonly<Record<IngressOutcome, number>> = {
  accepted: 200,
  malformed: 400,
  rejected: 401,
  not_found: 404,
  unavailable: 503,
};

function answer(reply: FastifyReply, outcome: IngressOutcome): FastifyReply {
  const status = INGRESS_STATUS[outcome];
  return outcome === 'accepted' ? reply.code(status).send({ ok: true }) : reply.code(status).send();
}

/**
 * The three unauthenticated surfaces (`/hooks`, `/callbacks`, `/healthz`) plus `/readyz` and
 * `/metrics`. Hooks and callbacks are authenticated by the plugin, rate-limited per instance,
 * log rejections with the remote address, and never return a body on rejection.
 */
export async function registerIngressRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  options: {
    prometheus?: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
    ready: () => boolean;
  },
): Promise<void> {
  // Raw bodies for signature verification: every content type arrives as a Buffer in this scope.
  await app.register((scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 },
      (_req, body, done) => {
        done(null, body);
      },
    );
    const rateLimit = {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          // Per instance: ids are case-insensitive, so `/hooks/ABC…` shares `/hooks/abc…`'s budget.
          keyGenerator: (req: FastifyRequest) => (req.url.split('?')[0] ?? '').toLowerCase(),
        },
      },
    };

    scope.post<{ Params: { sourceId: string } }>(
      '/hooks/:sourceId',
      rateLimit,
      async (req, reply) => {
        if (!isUuid(req.params.sourceId)) return reply.code(404).send();
        // Any failure here (Postgres down) answers 503 so the sender retries.
        const outcome = await ctx.pipeline
          .ingestPush(req.params.sourceId, toRawRequest(req, ctx.clock.now()))
          .catch((err: unknown): IngressOutcome => {
            req.log.error({ err, source_id: req.params.sourceId }, 'ingress failed');
            return 'unavailable';
          });
        if (outcome === 'rejected')
          req.log.warn({ source_id: req.params.sourceId, remote: req.ip }, 'hook rejected');
        return answer(reply, outcome);
      },
    );

    scope.post<{ Params: { destinationId: string } }>(
      '/callbacks/:destinationId',
      rateLimit,
      async (req, reply) => {
        if (!isUuid(req.params.destinationId)) return reply.code(404).send();
        const outcome = await ctx.pipeline
          .handleCallback(req.params.destinationId, toRawRequest(req, ctx.clock.now()))
          .catch((err: unknown): IngressOutcome => {
            req.log.error({ err, destination_id: req.params.destinationId }, 'callback failed');
            return 'unavailable';
          });
        if (outcome === 'rejected')
          req.log.warn(
            { destination_id: req.params.destinationId, remote: req.ip },
            'callback rejected',
          );
        return answer(reply, outcome);
      },
    );
    return Promise.resolve();
  });

  app.get('/healthz', () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    if (!(await databaseReachable(ctx.db)))
      return reply.code(503).send({ ok: false, reason: 'database unreachable' });
    if (!options.ready()) return reply.code(503).send({ ok: false, reason: 'starting' });
    return { ok: true };
  });

  if (options.prometheus) {
    const handler = options.prometheus;
    app.get('/metrics', (req, reply) => {
      reply.hijack();
      handler(req.raw, reply.raw);
    });
  }
}
