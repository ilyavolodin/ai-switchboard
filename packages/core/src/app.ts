import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { buildApiContext, type ApiContext } from './api/context.js';
import type { PipelinePort, PreviewPort } from './api/pipeline-port.js';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { OidcClient } from './auth/oidc.js';
import { pruneSessions } from './auth/sessions.js';
import { pruneLoginAttempts } from './auth/throttle.js';
import { systemClock, type Clock } from './clock.js';
import type { CoreConfig, OidcConfig } from './config.js';
import { connect, runMigrations, type Database } from './db/client.js';
import type { Deps } from './deps.js';
import { loggerFor, type CoreLogger } from './logger.js';
import { PluginHost, type PluginHostOptions } from './plugins/host.js';
import { PgBossQueue, type JobQueue } from './queue/queue.js';
import { buildServer } from './server.js';
import { createPipeline } from './services/pipeline/index.js';
import { cronPreview, filterPreview, inputPreview } from './services/preview.js';
import { getSettings, sharedCookieKey } from './services/settings.js';
import { traceForArtifact, traceForEvent } from './services/trace.js';
import { setupTelemetry, type TelemetryRuntime } from './telemetry/setup.js';
import { createTelemetry, type Telemetry } from './telemetry/telemetry.js';

export interface Switchboard {
  app: FastifyInstance;
  ctx: ApiContext;
  host: PluginHost;
  database: Database;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateOptions {
  config: CoreConfig;
  logger?: CoreLogger;
  clock?: Clock;
  queue?: JobQueue;
  telemetry?: Telemetry;
  telemetryRuntime?: TelemetryRuntime;
  database?: Database;
  plugins?: Pick<PluginHostOptions, 'builtin' | 'scanDirs'>;
  /** Overrides `config.adminPassword`; otherwise one is generated and printed once. */
  adminPassword?: string;
  runNpm?: ApiContext['runNpm'];
  registryFetch?: ApiContext['registryFetch'];
}

interface CoreJob {
  name: string;
  cron: string;
  run(deps: Deps, host: PluginHost): Promise<void>;
}

/** The core's own scheduled jobs; the pipeline registers its own. */
export const CORE_JOBS: readonly CoreJob[] = [
  { name: 'plugins.health', cron: '* * * * *', run: (_deps, host) => host.checkHealth() },
  {
    name: 'auth.prune',
    cron: '17 3 * * *',
    run: async ({ db, clock }) => {
      await pruneSessions(db, clock.now());
      await pruneLoginAttempts(db, clock.now());
    },
  },
];

async function waitForDatabase(
  database: Database,
  logger: CoreLogger,
  wait: CoreConfig['databaseWait'],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await database.db.execute(sql`select 1`);
      return;
    } catch (err) {
      if (attempt >= wait.attempts) throw err;
      logger.warn({ attempt }, 'waiting for Postgres');
      await new Promise((r) => setTimeout(r, wait.delayMs));
    }
  }
}

/** An issuer from the environment, or one saved in Settings with the secret from the environment. */
async function resolveOidc(
  database: Database,
  config: CoreConfig,
  cookieKey: string,
): Promise<OidcClient | undefined> {
  const stored = await getSettings(database.db);
  const oidcConfig: OidcConfig | undefined =
    config.oidc ??
    (stored.oidc && config.oidcClientSecret !== undefined
      ? { ...stored.oidc, clientSecret: config.oidcClientSecret }
      : undefined);
  return oidcConfig
    ? new OidcClient(oidcConfig, `${config.publicUrl}/api/v1/auth/oidc/callback`, cookieKey, {
        allowInsecure: config.evaluation,
      })
    : undefined;
}

function previewPort(deps: Deps): PreviewPort {
  return {
    filterPreview: (req) => filterPreview(deps, req),
    inputPreview: (req) => inputPreview(deps, req),
    cronPreview: (req) => cronPreview(req, deps.clock),
    traceForArtifact: (q) => traceForArtifact(deps, q),
    traceForEvent: (id) => traceForEvent(deps, id),
  };
}

/** Postgres ready and migrated, plugins loaded and instances built. */
async function bootState(
  options: CreateOptions,
  base: { config: CoreConfig; logger: CoreLogger; clock: Clock; telemetry: Telemetry },
): Promise<{ database: Database; host: PluginHost }> {
  const { config, logger } = base;
  const database = options.database ?? connect(config.databaseUrl);
  await waitForDatabase(database, logger, config.databaseWait);
  await runMigrations(database.db);
  const host = new PluginHost({
    ...base,
    db: database.db,
    ...options.plugins,
    ...(options.runNpm ? { runNpm: options.runNpm } : {}),
  });
  await host.boot();
  for (const p of host.loaded) {
    if (p.status === 'loaded')
      logger.info({ plugin: p.name, version: p.version, origin: p.origin }, 'plugin loaded');
  }
  return { database, host };
}

async function registerWorkers(
  deps: Deps,
  host: PluginHost,
  pipeline: { registerWorkers(): Promise<void> },
): Promise<void> {
  await pipeline.registerWorkers();
  for (const job of CORE_JOBS) {
    await deps.queue.work(job.name, () => job.run(deps, host), { concurrency: 1 });
    await deps.queue.schedule(job.name, job.cron);
  }
}

export async function createSwitchboard(options: CreateOptions): Promise<Switchboard> {
  const { config } = options;
  const logger = options.logger ?? loggerFor(config);
  const clock = options.clock ?? systemClock;
  const telemetryRuntime = options.telemetryRuntime ?? setupTelemetry(config, logger);
  const telemetry = options.telemetry ?? createTelemetry(logger);
  const { database, host } = await bootState(options, { config, logger, clock, telemetry });

  const queue = options.queue ?? new PgBossQueue(config.databaseUrl, logger);
  const deps: Deps = { db: database.db, clock, runtime: host, queue, logger, telemetry, config };
  const pipeline: PipelinePort & { registerWorkers(): Promise<void> } = createPipeline({
    ...deps,
    secrets: { resolve: (ref) => host.resolveSecret(ref) },
  });

  const adminPassword = options.adminPassword ?? config.adminPassword;
  await bootstrapAdmin(
    database.db,
    config,
    logger,
    clock.now(),
    adminPassword !== undefined ? { password: adminPassword } : {},
  );
  const cookieKey = await sharedCookieKey(database.db, clock.now());
  const ctx = buildApiContext({
    deps,
    host,
    pipeline,
    preview: previewPort(deps),
    oidc: await resolveOidc(database, config, cookieKey),
    runNpm: options.runNpm,
    registryFetch: options.registryFetch,
  });
  let ready = false;
  const app = await buildServer(ctx, {
    telemetry: telemetryRuntime,
    ready: () => ready,
    cookieSecret: cookieKey,
  });

  return {
    app,
    ctx,
    host,
    database,
    async start() {
      await queue.start();
      if (config.workers) await registerWorkers(deps, host, pipeline);
      // Every replica (not one queue worker) converges on the plugins admins installed and on
      // the instances changed through another replica.
      host.startSync();
      host.startReconcile();
      await app.listen({ host: config.host, port: config.port });
      ready = true;
      logger.info(
        { url: config.publicUrl, evaluation: config.evaluation, replica: config.replicaId },
        'switchboard listening',
      );
    },
    async stop() {
      ready = false;
      await app.close();
      await queue.stop();
      await host.stop();
      await telemetryRuntime.shutdown();
      if (!options.database) await database.close();
    },
  };
}
