import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { ApiContext } from './api/context.js';
import type { PipelinePort, PreviewPort } from './api/pipeline-port.js';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { OidcClient } from './auth/oidc.js';
import { pruneSessions } from './auth/sessions.js';
import { pruneLoginAttempts } from './auth/throttle.js';
import { systemClock, type Clock } from './clock.js';
import type { CoreConfig } from './config.js';
import { connect, runMigrations, type Database } from './db/client.js';
import { settings as settingsTable } from './db/schema.js';
import type { Deps } from './deps.js';
import { createLogger, type CoreLogger } from './logger.js';
import { PluginHost, type PluginHostOptions } from './plugins/host.js';
import { PgBossQueue, type JobQueue } from './queue/queue.js';
import { buildServer } from './server.js';
import { createPipeline } from './services/pipeline/index.js';
import { cronPreview, filterPreview, inputPreview } from './services/preview.js';
import { getSettings } from './services/settings.js';
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
  /** Evaluation admin password (tests, e2e); otherwise generated and printed once. */
  adminPassword?: string;
  runNpm?: ApiContext['runNpm'];
  registryFetch?: ApiContext['registryFetch'];
}

async function waitForDatabase(database: Database, logger: CoreLogger): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await database.db.execute(sql`select 1`);
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      logger.warn({ attempt }, 'waiting for Postgres');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** A cookie-signing key shared by every replica (so an OIDC flow can finish on any of them). */
async function sharedCookieKey(database: Database, now: Date): Promise<string> {
  const key = 'cookie_key';
  await database.db
    .insert(settingsTable)
    .values({ key, value: randomBytes(32).toString('base64url'), updatedAt: now })
    .onConflictDoNothing();
  const [row] = await database.db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return String(row?.value);
}

/** Wire every component. `start()` registers workers and listens; `stop()` drains. */
export async function createSwitchboard(options: CreateOptions): Promise<Switchboard> {
  const { config } = options;
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, pretty: config.prettyLogs });
  const clock = options.clock ?? systemClock;
  const telemetryRuntime = options.telemetryRuntime ?? setupTelemetry(config);
  const telemetry = options.telemetry ?? createTelemetry(logger);
  const database = options.database ?? connect(config.databaseUrl);
  await waitForDatabase(database, logger);
  await runMigrations(database.db);

  const host = new PluginHost({
    db: database.db,
    clock,
    logger,
    telemetry,
    config,
    ...options.plugins,
    ...(options.runNpm ? { runNpm: options.runNpm } : {}),
  });
  await host.boot();
  for (const p of host.loaded) {
    if (p.status === 'loaded')
      logger.info({ plugin: p.name, version: p.version, origin: p.origin }, 'plugin loaded');
  }

  const queue = options.queue ?? new PgBossQueue(config.databaseUrl, logger);
  const deps: Deps = { db: database.db, clock, runtime: host, queue, logger, telemetry, config };
  const pipeline: PipelinePort & { registerWorkers(): Promise<void> } = createPipeline({
    ...deps,
    secrets: { resolve: (ref) => host.resolveSecret(ref) },
  });
  const preview: PreviewPort = {
    filterPreview: (req) => filterPreview(deps, req),
    inputPreview: (req) => inputPreview(deps, req),
    cronPreview: (req) => cronPreview(req, clock),
    traceForArtifact: (q) => traceForArtifact(deps, q),
    traceForEvent: (id) => traceForEvent(deps, id),
  };

  await bootstrapAdmin(
    database.db,
    config,
    logger,
    clock.now(),
    options.adminPassword !== undefined ? { password: options.adminPassword } : {},
  );

  const stored = await getSettings(database.db);
  const oidcConfig =
    config.oidc ??
    (stored.oidc && process.env.SWITCHBOARD_OIDC_CLIENT_SECRET !== undefined
      ? { ...stored.oidc, clientSecret: process.env.SWITCHBOARD_OIDC_CLIENT_SECRET }
      : undefined);
  const cookieKey = await sharedCookieKey(database, clock.now());
  const oidc = oidcConfig
    ? new OidcClient(oidcConfig, `${config.publicUrl}/api/v1/auth/oidc/callback`, cookieKey, {
        allowInsecure: config.evaluation,
      })
    : undefined;

  const ctx: ApiContext = {
    ...deps,
    host,
    pipeline,
    preview,
    oidc,
    ...(options.runNpm ? { runNpm: options.runNpm } : {}),
    ...(options.registryFetch ? { registryFetch: options.registryFetch } : {}),
  };
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
      if (config.workers) {
        await pipeline.registerWorkers();
        await queue.work('plugins.health', () => host.checkHealth(), { concurrency: 1 });
        await queue.schedule('plugins.health', '* * * * *');
        await queue.work(
          'auth.prune',
          async () => {
            await pruneSessions(database.db, clock.now());
            await pruneLoginAttempts(database.db, clock.now());
          },
          { concurrency: 1 },
        );
        await queue.schedule('auth.prune', '17 3 * * *');
      }
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
