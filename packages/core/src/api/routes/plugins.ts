import type { FastifyInstance } from 'fastify';

import {
  inspectPackage,
  installPackage,
  packageSpec,
  searchPackages,
  uninstallPackage,
  type PluginAdminDeps,
} from '../../services/plugin-admin.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  inspectPluginBody,
  installPluginBody,
  type InspectPluginRequest,
  type InstallPluginRequest,
  type PluginSearchQuery,
  type PluginSearchResponse,
  type PluginSummary,
  type PluginTypesQuery,
  type Reasoned,
} from '../contract.js';
import { HttpError } from '../errors.js';
import {
  catalogue,
  pluginSummaries,
  pluginSummary,
  pluginTypeList,
  searchResults,
} from '../read/plugins.js';
import { allow } from './options.js';

export function registerPluginRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const deps: PluginAdminDeps = {
    db: ctx.db,
    config: ctx.config,
    host: ctx.host,
    runNpm: ctx.runNpm,
    registryFetch: ctx.registryFetch,
  };

  app.get<{ Querystring: PluginTypesQuery }>('/api/v1/plugin-types', allow('viewer'), async (req) =>
    pluginTypeList(ctx, req.query.kind),
  );

  app.get('/api/v1/plugins', allow('viewer'), async () => pluginSummaries(ctx));

  app.get<{ Querystring: PluginSearchQuery }>(
    '/api/v1/plugins/search',
    allow('viewer'),
    async (req): Promise<PluginSearchResponse> => {
      const found = await searchPackages(deps, req.query.kind, req.query.q);
      return { registry: ctx.config.npmRegistry, results: await searchResults(ctx, found) };
    },
  );

  app.get('/api/v1/plugins/catalogue', allow('viewer'), async () => catalogue(ctx));

  app.post<{ Body: InspectPluginRequest }>(
    '/api/v1/plugins/inspect',
    allow('admin', inspectPluginBody),
    async (req) => inspectPackage(deps, packageSpec(req.body.package, req.body.range)),
  );

  app.post<{ Body: InstallPluginRequest }>(
    '/api/v1/plugins',
    allow('admin', installPluginBody),
    async (req, reply) => {
      const meta = changeMeta(req, ctx.clock);
      const outcome = await installPackage(
        deps,
        packageSpec(req.body.package, req.body.range),
        meta,
      );
      const summary = await pluginSummary(ctx, outcome.name);
      if (!summary) throw new HttpError(500, 'internal', 'the installed plugin has no row');
      return reply.code(201).send({
        ...summary,
        pendingRestart: outcome.pendingRestart,
        ...(outcome.warnings.length > 0 && !outcome.pendingRestart && !outcome.loaded
          ? { statusMessage: outcome.warnings.join('; ') }
          : {}),
      } satisfies PluginSummary);
    },
  );

  // Fastify has already decoded the path parameter (`%40acme%2Fbell` → `@acme/bell`).
  app.delete<{ Params: { name: string }; Body: Reasoned }>(
    '/api/v1/plugins/:name',
    allow('admin'),
    async (req, reply) => {
      await uninstallPackage(deps, req.params.name, changeMeta(req, ctx.clock));
      return reply.code(204).send();
    },
  );
}
