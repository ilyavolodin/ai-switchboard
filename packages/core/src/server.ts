import { join } from 'node:path';

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuth } from './auth/fastify.js';
import type { ApiContext } from './api/context.js';
import { registerErrorHandler } from './api/errors.js';
import { rewriteLegacyUrl } from './api/legacy.js';
import { createReasonPolicy, registerReasonPolicy } from './api/reasons.js';
import { registerAdminRoutes } from './api/routes/admin.js';
import { registerAuthRoutes } from './api/routes/auth.js';
import { registerConfigRoutes } from './api/routes/config.js';
import { registerIngressRoutes } from './api/routes/ingress.js';
import { registerInstanceRoutes } from './api/routes/instances.js';
import { registerPluginRoutes } from './api/routes/plugins.js';
import { registerProcessRoutes } from './api/routes/processes.js';
import { registerReadRoutes } from './api/routes/read.js';
import { registerSecretRoutes } from './api/routes/secrets.js';
import { registerSourcePreviewRoutes } from './api/routes/source-preview.js';
import { getSettings } from './services/settings.js';
import { registerHttpTelemetry } from './telemetry/http.js';
import type { TelemetryRuntime } from './telemetry/setup.js';
import { exists } from './util/fs.js';

export interface ServerOptions {
  telemetry?: TelemetryRuntime;
  serveUi?: boolean;
  ready?: () => boolean;
  cookieSecret?: string;
}

export async function buildServer(
  ctx: ApiContext,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  // Fastify infers its logger generic from pino; the rest of the code uses the default instance type.
  const app = Fastify({
    loggerInstance: ctx.logger.child({ component: 'http' }),
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    // Deprecated `executor` URLs are served by the `destination` routes (api/legacy.ts).
    rewriteUrl: (req) => rewriteLegacyUrl(req.url ?? '/'),
    ajv: {
      customOptions: {
        allErrors: true,
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
      },
    },
  }) as unknown as FastifyInstance;
  // Before any route, so its onRoute hook wraps every handler in the request's span.
  registerHttpTelemetry(app);
  registerErrorHandler(app);
  await app.register(cookie, options.cookieSecret ? { secret: options.cookieSecret } : {});
  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx.db, ctx.clock);
  registerReasonPolicy(
    app,
    createReasonPolicy(async () => (await getSettings(ctx.db)).requireReasons, ctx.clock),
  );

  await registerIngressRoutes(app, ctx, {
    prometheus: options.telemetry?.prometheus,
    ready: options.ready ?? (() => true),
  });
  registerAuthRoutes(app, ctx);
  registerSourcePreviewRoutes(app, ctx);
  registerInstanceRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerProcessRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerReadRoutes(app, ctx);

  app.all('/api/*', (_req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'No such API route.' }),
  );

  const uiIndex = join(ctx.config.uiDir, 'index.html');
  if (options.serveUi !== false && (await exists(uiIndex))) {
    await app.register(fastifyStatic, { root: ctx.config.uiDir, wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', () => ({
      name: 'AI Switchboard',
      ui: 'not built; run pnpm --filter @ai-switchboard/ui build',
    }));
  }
  return app;
}
