import { readdir } from 'node:fs/promises';

import { sql } from 'drizzle-orm';

import { systemClock } from './clock.js';
import type { CoreConfig } from './config.js';
import { connect, migrationsFolder } from './db/client.js';
import { destinations, notifiers, secretProviders, sources } from './db/schema.js';
import { silentLogger } from './logger.js';
import { PluginHost } from './plugins/host.js';
import { createRecordingTelemetry } from './telemetry/telemetry.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref(),
    ),
  ]);
}

/** Read-only except for the plugin registry refresh the host does. */
export async function runDoctor(config: CoreConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const database = connect(config.databaseUrl, { max: 2 });
  try {
    try {
      const r = await database.db.execute<{ version: string }>(sql`select version()`);
      checks.push({
        name: 'database',
        ok: true,
        detail: r.rows[0]?.version.split(',')[0] ?? 'reachable',
      });
    } catch (err) {
      checks.push({
        name: 'database',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return checks;
    }

    const files = (await readdir(migrationsFolder)).filter((f) => f.endsWith('.sql'));
    try {
      const applied = await database.db.execute<{ n: string }>(
        sql`select count(*)::text as n from drizzle.__drizzle_migrations`,
      );
      const n = Number(applied.rows[0]?.n ?? 0);
      checks.push({
        name: 'migrations',
        ok: n >= files.length,
        detail: `${n} of ${files.length} applied`,
      });
    } catch {
      checks.push({
        name: 'migrations',
        ok: false,
        detail: `none applied (${files.length} pending); start the server once to migrate`,
      });
    }

    const host = new PluginHost({
      db: database.db,
      clock: systemClock,
      logger: silentLogger(),
      telemetry: createRecordingTelemetry(),
      config,
    });
    await host.boot();
    for (const p of host.loaded) {
      checks.push({
        name: `plugin ${p.name}@${p.version}`,
        ok: p.status === 'loaded',
        detail: p.message ?? p.status,
      });
    }

    const kinds = [
      {
        kind: 'secret provider',
        rows: await database.db.select().from(secretProviders),
        live: (id: string) => host.secretProvider(id)?.provider,
      },
      {
        kind: 'source',
        rows: await database.db.select().from(sources),
        live: (id: string) => host.source(id)?.source,
      },
      {
        kind: 'destination',
        rows: await database.db.select().from(destinations),
        live: (id: string) => host.destination(id)?.destination,
      },
      {
        kind: 'notifier',
        rows: await database.db.select().from(notifiers),
        live: (id: string) => host.notifier(id)?.notifier,
      },
    ];
    for (const { kind, rows, live } of kinds) {
      for (const row of rows) {
        if (!row.enabled) continue;
        const error = host.instanceError(row.id);
        const obj = live(row.id);
        if (!obj || (error !== undefined && error !== 'disabled')) {
          checks.push({ name: `${kind} ${row.name}`, ok: false, detail: error ?? 'not running' });
          continue;
        }
        try {
          const h = await withTimeout(obj.health(), 10_000);
          checks.push({
            name: `${kind} ${row.name}`,
            ok: h.status !== 'unhealthy',
            detail: `secrets resolved; health ${h.status}${h.message ? `: ${h.message}` : ''}`,
          });
        } catch (err) {
          checks.push({
            name: `${kind} ${row.name}`,
            ok: false,
            detail: `health() threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    await host.stop();
    return checks;
  } finally {
    await database.close();
  }
}
