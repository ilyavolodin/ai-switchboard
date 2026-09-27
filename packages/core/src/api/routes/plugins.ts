import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { actorOf, requireRole } from '../../auth/fastify.js';
import {
  executors,
  notifiers,
  plugins,
  pluginTypes,
  secretProviders,
  sources,
} from '../../db/schema.js';
import { pluginStatusLabel } from '../../domain/labels.js';
import {
  inspectPlugin,
  isPluginInstallError,
  listInstalled,
  removePlugin,
} from '../../plugins/install.js';
import { isPluginNameKind, PLUGIN_NAME_KINDS, pluginKindOf } from '../../plugins/naming.js';
import { isRegistryUnavailableError, searchRegistry } from '../../plugins/search.js';
import { recordAudit } from '../../services/audit.js';
import type { ApiContext } from '../context.js';
import type {
  CatalogueEntry,
  InspectPluginRequest,
  InspectPluginResponse,
  InstallPluginRequest,
  PluginKind,
  PluginSearchResponse,
  PluginSummary,
  PluginTypeDTO,
} from '../contract.js';
import { badRequest, HttpError, notFound, requireReason, unprocessable } from '../errors.js';

/** The project's reviewed plugins. Reference plugins ship in the image. */
export const CATALOGUE: Omit<CatalogueEntry, 'installed'>[] = [
  {
    package: '@ai-switchboard/source-webhook',
    displayName: 'Webhook',
    description: 'Any system that can POST JSON; map it with JSONata.',
    kinds: ['source'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/source-poll-http',
    displayName: 'Poll HTTP',
    description: 'Poll a JSON endpoint with a cursor.',
    kinds: ['source'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/source-github',
    displayName: 'GitHub',
    description: 'Pull requests, issues, check suites, releases, pushes.',
    kinds: ['source'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/source-linear',
    displayName: 'Linear',
    description: 'Issue label and state changes.',
    kinds: ['source'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/source-datadog',
    displayName: 'Datadog',
    description: 'Monitor alerts through a webhook integration.',
    kinds: ['source'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/executor-http',
    displayName: 'HTTP',
    description: 'Call any endpoint: sync, callback or fire-and-forget.',
    kinds: ['executor'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/executor-claude-routines',
    displayName: 'Claude Routines',
    description: 'Fire a routine; windows and daily allowance as meters.',
    kinds: ['executor'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/executor-github-actions',
    displayName: 'GitHub Actions',
    description: 'workflow_dispatch with billable-minute usage.',
    kinds: ['executor'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/executor-log',
    displayName: 'Log (testing)',
    description:
      'Logs every invocation and simulates outcomes, delays and a meter — for trying processes out.',
    kinds: ['executor'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/notifier-slack',
    displayName: 'Slack',
    description: 'Run outcomes and system alerts to a channel.',
    kinds: ['notifier'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/notifier-webhook',
    displayName: 'Webhook notifier',
    description: 'POST notifications as signed JSON.',
    kinds: ['notifier'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/secrets-env',
    displayName: 'Environment secrets',
    description: 'Resolve secret:// references from environment variables.',
    kinds: ['secret_provider'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
  {
    package: '@ai-switchboard/secrets-file',
    displayName: 'File secrets',
    description: 'Resolve references from mounted files (Kubernetes secrets).',
    kinds: ['secret_provider'],
    reviewed: true,
    latestVersion: '1.0.0',
  },
];

const SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

const packageBody = {
  type: 'object',
  required: ['package'],
  properties: { package: { type: 'string' }, range: { type: 'string' } },
} as const;
const installBody = {
  ...packageBody,
  required: ['package', 'reason'],
  properties: { ...packageBody.properties, reason: { type: 'string' } },
} as const;

function specOf(pkg: string, range?: string): string {
  if (!SPEC.test(pkg))
    throw badRequest('Give an npm package name such as @acme/switchboard-source-jira.');
  if (range !== undefined && range !== '' && !/^[\w.^~<>=*|\s-]+$/.test(range))
    throw badRequest('That version range is not valid.');
  return range ? `${pkg}@${range}` : pkg;
}

export function typeDTO(kind: PluginKind, row: typeof pluginTypes.$inferSelect): PluginTypeDTO {
  const m = row.manifest;
  return {
    kind,
    typeId: row.typeId,
    displayName: row.displayName,
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
    plugin: row.plugin,
    available: row.available,
    settingsSchema: (m.settingsSchema as PluginTypeDTO['settingsSchema'] | undefined) ?? {
      type: 'object',
    },
    ...(kind === 'source'
      ? {
          mode: m.mode as PluginTypeDTO['mode'],
          eventTypes: (m.eventTypes as PluginTypeDTO['eventTypes']) ?? [],
          dynamicEventTypes: m.dynamicEventTypes === true,
          allowsUnauthenticated: m.allowsUnauthenticated === true,
          actions: (m.actions as PluginTypeDTO['actions']) ?? [],
        }
      : {}),
    ...(kind === 'executor'
      ? {
          targetSchema: m.targetSchema as PluginTypeDTO['targetSchema'],
          inputSchema: m.inputSchema as PluginTypeDTO['inputSchema'],
          tracking: m.tracking as PluginTypeDTO['tracking'],
          idempotentInvoke: m.idempotentInvoke === true,
          usage: (m.usage as PluginTypeDTO['usage']) ?? [],
          meters: (m.meters as PluginTypeDTO['meters']) ?? [],
          examples: (m.examples as PluginTypeDTO['examples']) ?? [],
          actions: (m.actions as PluginTypeDTO['actions']) ?? [],
        }
      : {}),
  };
}

export function registerPluginRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, clock, config } = ctx;
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };
  const runNpm = ctx.runNpm;

  app.get<{ Querystring: { kind?: PluginKind } }>('/api/v1/plugin-types', viewer, async (req) => {
    const rows = await db
      .select()
      .from(pluginTypes)
      .where(req.query.kind ? eq(pluginTypes.kind, req.query.kind) : undefined)
      .orderBy(pluginTypes.displayName);
    return rows.map((r) => typeDTO(r.kind, r));
  });

  const instanceCounts = async (): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    const add = (kind: string, rows: { typeId: string; n: number }[]) => {
      for (const r of rows) out.set(`${kind}:${r.typeId}`, r.n);
    };
    add(
      'source',
      await db.select({ typeId: sources.typeId, n: count() }).from(sources).groupBy(sources.typeId),
    );
    add(
      'executor',
      await db
        .select({ typeId: executors.typeId, n: count() })
        .from(executors)
        .groupBy(executors.typeId),
    );
    add(
      'notifier',
      await db
        .select({ typeId: notifiers.typeId, n: count() })
        .from(notifiers)
        .groupBy(notifiers.typeId),
    );
    add(
      'secret_provider',
      await db
        .select({ typeId: secretProviders.typeId, n: count() })
        .from(secretProviders)
        .groupBy(secretProviders.typeId),
    );
    return out;
  };

  const pluginSummaries = async (): Promise<PluginSummary[]> => {
    const [rows, types, counts, lock] = await Promise.all([
      db.select().from(plugins).orderBy(plugins.displayName),
      db.select().from(pluginTypes),
      instanceCounts(),
      listInstalled(config.home).catch(() => []),
    ]);
    const summaries: PluginSummary[] = rows.map((p) => {
      const locked = lock.find((l) => l.name === p.name);
      const pendingRestart =
        p.origin === 'installed' && locked !== undefined && locked.version !== p.version;
      return {
        name: p.name,
        pluginId: p.pluginId,
        displayName: p.displayName,
        version: p.version,
        status: p.status as PluginSummary['status'],
        statusLabel: pendingRestart
          ? { tone: 'warn', label: 'restart to apply' }
          : pluginStatusLabel(p.status),
        statusMessage: pendingRestart
          ? `Version ${locked.version} is installed; restart to load it.`
          : p.statusMessage,
        origin: p.origin as PluginSummary['origin'],
        sdkRange: p.sdkRange,
        capabilities: p.capabilities,
        types: types
          .filter((t) => t.plugin === p.name)
          .map((t) => ({
            kind: t.kind,
            typeId: t.typeId,
            displayName: t.displayName,
            instanceCount: counts.get(`${t.kind}:${t.typeId}`) ?? 0,
          })),
        errorCount: p.errorCount,
        invalidEventCount: p.invalidEventCount,
        integrity: locked?.integrity ?? p.integrity,
        pendingRestart,
      };
    });
    // Added with the CLI since the last start: in the lockfile, not yet loaded.
    for (const l of lock) {
      if (rows.some((r) => r.name === l.name)) continue;
      summaries.push({
        name: l.name,
        pluginId: l.name,
        displayName: l.name,
        version: l.version,
        status: 'unavailable',
        statusLabel: { tone: 'warn', label: 'restart to load' },
        statusMessage: 'Installed; the host loads it on the next start.',
        origin: 'installed',
        sdkRange: l.sdk,
        capabilities: {},
        types: [],
        errorCount: 0,
        invalidEventCount: 0,
        integrity: l.integrity,
        pendingRestart: true,
      });
    }
    return summaries;
  };

  app.get('/api/v1/plugins', viewer, async (): Promise<PluginSummary[]> => pluginSummaries());

  app.get<{ Querystring: { kind?: string; q?: string } }>(
    '/api/v1/plugins/search',
    viewer,
    async (req): Promise<PluginSearchResponse> => {
      const { kind, q } = req.query;
      if (kind !== undefined && kind !== '' && !isPluginNameKind(kind))
        throw badRequest(`kind must be one of ${PLUGIN_NAME_KINDS.join(', ')}.`);
      const query = (q ?? '').trim().slice(0, 100);
      let found;
      try {
        found = await searchRegistry({
          registry: config.npmRegistry,
          ...(isPluginNameKind(kind) ? { kind } : {}),
          q: query,
          ...(ctx.registryFetch ? { fetch: ctx.registryFetch } : {}),
        });
      } catch (err) {
        if (isRegistryUnavailableError(err))
          throw new HttpError(
            503,
            'registry_unavailable',
            `${err.message} Search needs the registry; install by name with Add plugin, or bake plugins into the image for offline installs.`,
          );
        throw err;
      }
      const [rows, lock] = await Promise.all([
        db
          .select({ name: plugins.name, version: plugins.version, status: plugins.status })
          .from(plugins),
        listInstalled(config.home).catch(() => []),
      ]);
      const reviewed = new Set(CATALOGUE.map((c) => c.package));
      return {
        registry: config.npmRegistry,
        results: found.map((pkg) => {
          const row = rows.find((r) => r.name === pkg.name && r.status === 'loaded');
          const locked = lock.find((l) => l.name === pkg.name);
          const installedVersion = locked?.version ?? row?.version ?? null;
          return {
            package: pkg.name,
            kind: pluginKindOf(pkg.kind),
            version: pkg.version,
            description: pkg.description,
            publisher: pkg.publisher,
            date: pkg.date,
            links: pkg.links,
            weeklyDownloads: pkg.weeklyDownloads,
            installed: installedVersion !== null,
            installedVersion,
            reviewed: reviewed.has(pkg.name),
          };
        }),
      };
    },
  );

  app.get('/api/v1/plugins/catalogue', viewer, async (): Promise<CatalogueEntry[]> => {
    const rows = await db.select({ name: plugins.name, status: plugins.status }).from(plugins);
    return CATALOGUE.map((c) => ({
      ...c,
      installed: rows.some((r) => r.name === c.package && r.status === 'loaded'),
    }));
  });

  const installError = (err: unknown): never => {
    if (isPluginInstallError(err)) throw unprocessable(err.message);
    throw err;
  };

  app.post<{ Body: InspectPluginRequest }>(
    '/api/v1/plugins/inspect',
    { ...admin, schema: { body: packageBody } },
    async (req): Promise<InspectPluginResponse> => {
      const spec = specOf(req.body.package, req.body.range);
      const result = await inspectPlugin({ spec, ...(runNpm ? { runNpm } : {}) }).catch(
        installError,
      );
      return {
        package: result.name,
        version: result.version,
        sdkRange: result.sdkRange,
        compatible: result.compatible,
        capabilities: result.capabilities ?? {},
        types: result.plugin?.types ?? [],
        integrity: result.integrity,
      };
    },
  );

  app.post<{ Body: InstallPluginRequest }>(
    '/api/v1/plugins',
    { ...admin, schema: { body: installBody } },
    async (req, reply) => {
      const reason = requireReason(req.body);
      const spec = specOf(req.body.package, req.body.range);
      const {
        install: result,
        plugin,
        pendingRestart,
      } = await ctx.host.installAndLoad(spec, runNpm).catch(installError);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'plugin',
        targetId: result.name,
        field: 'installed',
        after: {
          spec,
          version: result.version,
          integrity: result.integrity,
          capabilities: result.capabilities ?? null,
          loaded: plugin.status === 'loaded' && !pendingRestart,
        },
        reason,
        at: clock.now(),
      });
      const summary = (await pluginSummaries()).find((p) => p.name === result.name);
      if (!summary) throw new HttpError(500, 'internal', 'the installed plugin has no row');
      const warnings = [...result.warnings, ...(plugin.message ? [plugin.message] : [])];
      return reply.code(201).send({
        ...summary,
        pendingRestart,
        ...(warnings.length > 0 && !pendingRestart && plugin.status !== 'loaded'
          ? { statusMessage: warnings.join('; ') }
          : {}),
      } satisfies PluginSummary);
    },
  );

  app.delete<{ Params: { name: string }; Body: { reason: string } }>(
    '/api/v1/plugins/:name',
    admin,
    async (req, reply) => {
      const reason = requireReason(req.body);
      // Fastify has already decoded the path parameter (`%40acme%2Fbell` → `@acme/bell`).
      const name = req.params.name;
      const [row] = await db.select().from(plugins).where(eq(plugins.name, name));
      const installed = (await listInstalled(config.home)).find((l) => l.name === name);
      if (!installed && !row?.installSpec) {
        if (row?.origin === 'baked')
          throw unprocessable(`${name} is baked into the image; rebuild without it to remove it.`);
        throw notFound('Installed plugin');
      }
      if (installed) {
        await removePlugin({ home: config.home, name, ...(runNpm ? { runNpm } : {}) }).catch(
          installError,
        );
      }
      // Replicas stop installing it; the loaded code stays in memory until the next restart.
      await ctx.host.forgetInstall(name);
      await recordAudit(db, {
        actor: actorOf(req),
        scope: 'plugin',
        targetId: name,
        field: 'removed',
        before: { version: installed?.version ?? row?.installVersion ?? row?.version ?? null },
        reason,
        at: clock.now(),
      });
      return reply.code(204).send();
    },
  );
}
