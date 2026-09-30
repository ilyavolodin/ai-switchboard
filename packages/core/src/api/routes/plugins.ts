import type { FastifyInstance } from 'fastify';

import {
  inspectPackage,
  installPackage,
  packageSpec,
  searchPackages,
  uninstallPackage,
  type InstalledOutcome,
} from '../../services/plugin-admin.js';
import { changeMeta } from '../change.js';
import type { ApiContext } from '../context.js';
import {
  inspectPluginBody,
  installPluginBody,
  pluginSearchQuery,
  pluginTypesQuery,
  type InspectPluginRequest,
  type InstallPluginRequest,
  type PluginSearchQuery,
  type PluginSearchResponse,
  type PluginSummary,
  type PluginTypesQuery,
  type Reasoned,
} from '../../contract/index.js';
import { DomainError } from '../errors.js';
import {
  catalogue,
  pluginSummaries,
  pluginSummary,
  pluginTypeList,
  searchResults,
} from '../read/plugins.js';
import { allow, pluginAdminDeps } from './options.js';

/** The installed plugin's summary; the install warnings only when it did not load. */
async function installedSummary(
  ctx: ApiContext,
  outcome: InstalledOutcome,
): Promise<PluginSummary> {
  const summary = await pluginSummary(ctx, outcome.name);
  if (!summary) throw new DomainError('internal', 'the installed plugin has no row');
  return {
    ...summary,
    pendingRestart: outcome.pendingRestart,
    ...(outcome.warnings.length > 0 && !outcome.pendingRestart && !outcome.loaded
      ? { statusMessage: outcome.warnings.join('; ') }
      : {}),
  };
}

export function registerPluginRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const deps = pluginAdminDeps(ctx);

  app.get<{ Querystring: PluginTypesQuery }>(
    '/api/v1/plugin-types',
    allow('viewer', { querystring: pluginTypesQuery }),
    async (req) => pluginTypeList(ctx, req.query.kind),
  );

  app.get('/api/v1/plugins', allow('viewer'), async () => pluginSummaries(ctx));

  app.get<{ Querystring: PluginSearchQuery }>(
    '/api/v1/plugins/search',
    allow('viewer', { querystring: pluginSearchQuery }),
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
      return reply.code(201).send(await installedSummary(ctx, outcome));
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
