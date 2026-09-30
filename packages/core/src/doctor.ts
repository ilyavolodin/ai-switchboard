import { readdir } from 'node:fs/promises';

import { sql } from 'drizzle-orm';

import { systemClock } from './clock.js';
import type { CoreConfig } from './config.js';
import { connect, migrationsFolder, type Db } from './db/client.js';
import { INSTANCE_TABLES, type InstanceTable } from './db/instance-tables.js';
import { instanceErrorText } from './domain/instance-error.js';
import type { InstanceKind } from './domain/status.js';
import { silentLogger } from './logger.js';
import { probeHealth } from './plugins/health.js';
import { PluginHost } from './plugins/host.js';
import { BUILD_ORDER, KIND_SPECS } from './plugins/instances/kind-specs.js';
import { createRecordingTelemetry } from './telemetry/telemetry.js';
import { errorText } from './util/errors.js';

const KIND_LABELS: Record<InstanceKind, string> = {
  source: 'source',
  destination: 'destination',
  notifier: 'notifier',
  secret_provider: 'secret provider',
};

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function instanceChecks<K extends InstanceKind>(
  db: Db,
  host: PluginHost,
  kind: K,
): Promise<DoctorCheck[]> {
  const t: InstanceTable = INSTANCE_TABLES[kind];
  const rows = await db.select({ id: t.id, name: t.name, enabled: t.enabled }).from(t);
  const checks: DoctorCheck[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const name = `${KIND_LABELS[kind]} ${row.name}`;
    const error = host.instanceError(row.id);
    const live = host.instance(kind, row.id);
    if (!live || (error !== undefined && error.code !== 'disabled')) {
      checks.push({ name, ok: false, detail: instanceErrorText(error) ?? 'not running' });
      continue;
    }
    const object = KIND_SPECS[kind].objectOf(live);
    const h = await probeHealth(() => object.health(), systemClock);
    checks.push({
      name,
      ok: h.status !== 'unhealthy',
      detail: `secrets resolved; health ${h.status}${h.message ? `: ${h.message}` : ''}`,
    });
  }
  return checks;
}

/** Writes nothing: the host neither records what it loads nor installs what replicas recorded. */
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
        detail: errorText(err),
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
      persist: false,
    });
    await host.boot({ sync: false });
    for (const p of host.loaded) {
      checks.push({
        name: `plugin ${p.name}@${p.version}`,
        ok: p.status === 'loaded',
        detail: p.message ?? p.status,
      });
    }
    for (const kind of BUILD_ORDER) checks.push(...(await instanceChecks(database.db, host, kind)));
    await host.stop();
    return checks;
  } finally {
    await database.close();
  }
}
