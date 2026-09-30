import { SDK_VERSION } from '@ai-switchboard/sdk';
import { desc, eq, sql } from 'drizzle-orm';

import { plugins, replicas } from '../../db/schema.js';
import { telemetryStatus } from '../../telemetry/otel-config.js';
import type { ApiContext } from '../context.js';
import type { AboutResponse } from '../../contract/index.js';

/** A replica whose heartbeat is older than this is shown as gone. */
const LIVE_HEARTBEAT_MS = 90_000;

export async function about(ctx: ApiContext): Promise<AboutResponse> {
  const { db, config } = ctx;
  const now = ctx.clock.now().getTime();
  const [reps, pluginRows, version] = await Promise.all([
    db.select().from(replicas).orderBy(desc(replicas.heartbeatAt)),
    db.select({ name: plugins.name }).from(plugins).where(eq(plugins.status, 'loaded')),
    db.execute<{ version: string }>(sql`select version()`).then(
      (r) => r.rows[0]?.version ?? null,
      () => null,
    ),
  ]);
  return {
    version: config.version,
    sdkVersion: SDK_VERSION,
    replicas: reps.map((r) => ({
      id: r.id,
      hostname: r.hostname,
      version: r.version,
      startedAt: r.startedAt.toISOString(),
      heartbeatAt: r.heartbeatAt.toISOString(),
      live: now - r.heartbeatAt.getTime() < LIVE_HEARTBEAT_MS,
    })),
    database: { ok: version !== null, version },
    plugins: pluginRows.length,
    evaluation: config.evaluation,
    publicUrl: config.publicUrl,
    telemetry: telemetryStatus(config.telemetry),
  };
}
