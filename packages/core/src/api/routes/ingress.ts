import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RawRequest } from '@ai-switchboard/sdk';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          keyGenerator: (req: FastifyRequest) => req.url.split('?')[0] ?? '',
        },
      },
    };

    scope.post<{ Params: { sourceId: string } }>(
      '/hooks/:sourceId',
      rateLimit,
      async (req, reply) => {
        if (!UUID.test(req.params.sourceId)) return reply.code(404).send();
        // Any failure here (Postgres down) answers 503 so the sender retries.
        const result = await ctx.pipeline
          .ingestPush(req.params.sourceId, toRawRequest(req, ctx.clock.now()))
          .catch((err: unknown) => {
            req.log.error({ err, source_id: req.params.sourceId }, 'ingress failed');
            return { status: 503 };
          });
        if (result.status === 401)
          req.log.warn({ source_id: req.params.sourceId, remote: req.ip }, 'hook rejected');
        if (result.status >= 400) return reply.code(result.status).send();
        return reply.code(result.status).send({ ok: true });
      },
    );

    scope.post<{ Params: { executorId: string } }>(
      '/callbacks/:executorId',
      rateLimit,
      async (req, reply) => {
        if (!UUID.test(req.params.executorId)) return reply.code(404).send();
        const result = await ctx.pipeline
          .handleCallback(req.params.executorId, toRawRequest(req, ctx.clock.now()))
          .catch((err: unknown) => {
            req.log.error({ err, executor_id: req.params.executorId }, 'callback failed');
            return { status: 503 };
          });
        if (result.status === 401)
          req.log.warn({ executor_id: req.params.executorId, remote: req.ip }, 'callback rejected');
        if (result.status >= 400) return reply.code(result.status).send();
        return reply.code(result.status).send({ ok: true });
      },
    );
    return Promise.resolve();
  });

  app.get('/healthz', () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
    } catch {
      return reply.code(503).send({ ok: false, reason: 'database unreachable' });
    }
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
