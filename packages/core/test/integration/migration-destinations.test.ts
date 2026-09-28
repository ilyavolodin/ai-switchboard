import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../../src/db/client.js';
import {
  auditLog,
  batches,
  destinations,
  meterReadings,
  pluginTypes,
  plugins,
  processes,
  processVersions,
  runs,
  statsHourly,
  systemAlerts,
} from '../../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * The 0008 migration renames "executor" to "destination". This test builds a database on the
 * schema just before it (migrations 0000–0007), writes rows the way the old code did, then runs
 * the full migration set and checks that every row survived under the new names.
 */

const DEST = '11111111-1111-4111-8111-111111111111';
const PROC = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

let tdb: TestDatabase;
let oldFolder: string;

/** A copy of the migrations folder whose journal stops at `lastIdx`. */
async function migrationsUpTo(lastIdx: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-migrations-'));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

const oldDocument = {
  name: 'Autofix',
  description: '',
  triggers: [],
  schedules: [],
  batching: { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 600 },
  gates: { approval: 'none', breaker: { threshold: 3, cooldownMinutes: 60 } },
  budgets: { runsPerDay: 20, meterCeilings: {} },
  executor: { instanceId: DEST, target: { routine: 'autofix' } },
  input: '{}',
  before: [],
  after: [],
};

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  oldFolder = await migrationsUpTo(7);
  await migrate(tdb.db, { migrationsFolder: oldFolder });

  const q = (text: string, values: unknown[] = []) => tdb.pool.query(text, values);
  await q(`INSERT INTO executors (id, type_id, name, caps) VALUES ($1, 'http', 'Stub', $2)`, [
    DEST,
    { runsPerHour: 5 },
  ]);
  await q(
    `INSERT INTO plugins (name, plugin_id, display_name, version, sdk_range, status)
     VALUES ('@ai-switchboard/executor-http', 'executor-http', 'HTTP', '1.0.0', '^1.3.0', 'loaded'),
            ('@ai-switchboard/source-webhook', 'source-webhook', 'Webhook', '1.0.0', '^1.4.0', 'loaded')`,
  );
  await q(
    `INSERT INTO plugin_types (plugin, kind, type_id, display_name, manifest)
     VALUES ('@ai-switchboard/executor-http', 'executor', 'http', 'HTTP', '{}'),
            ('@ai-switchboard/source-webhook', 'source', 'webhook', 'Webhook', '{}')`,
  );
  await q(`INSERT INTO processes (id, name, document) VALUES ($1, 'Autofix', $2)`, [
    PROC,
    oldDocument,
  ]);
  await q(
    `INSERT INTO process_versions (process_id, version, document, saved_by, reason)
     VALUES ($1, 1, $2, 'ada@example.com', 'first')`,
    [PROC, oldDocument],
  );
  await q(
    `INSERT INTO batches (id, process_id, kind, opened_at, fire_after, outcome, outcome_reason, decisions)
     VALUES ($1, $2, 'event', now(), now(), 'held', 'executor_unhealthy', $3)`,
    [
      BATCH,
      PROC,
      JSON.stringify([
        { stage: 'gate', check: 'executor_enabled', pass: true, at: '2026-01-01T00:00:00Z' },
        {
          stage: 'gate',
          check: 'executor_healthy',
          pass: false,
          detail: 'unhealthy',
          at: '2026-01-01T00:00:00Z',
        },
      ]),
    ],
  );
  await q(
    `INSERT INTO runs (id, batch_id, process_id, process_version, executor_id, kind, status, status_reason)
     VALUES ($1, $2, $3, 1, $4, 'event', 'failed', 'executor_unavailable')`,
    [RUN, BATCH, PROC, DEST],
  );
  await q(
    `INSERT INTO meter_readings (executor_id, meter_id, observed_at, utilization)
     VALUES ($1, 'window', now(), 0.5)`,
    [DEST],
  );
  await q(
    `INSERT INTO audit_log (actor, scope, target_id, field, before, after, reason)
     VALUES ('ada@example.com', 'executor', $1, 'enabled', 'true', 'false', 'maintenance'),
            ('ada@example.com', 'process', $2, 'executor', $3, $3, 'rebind'),
            ('ada@example.com', 'process', $2, 'restored', $4, $4, 'restore')`,
    [DEST, PROC, JSON.stringify(oldDocument.executor), JSON.stringify(oldDocument)],
  );
  await q(
    `INSERT INTO stats_hourly (dimension, key, hour, counters)
     VALUES ('executor', $1, date_trunc('hour', now()), '{"runs:ok": 3}')`,
    [DEST],
  );
  await q(
    `INSERT INTO system_alerts (key, last_sent_at) VALUES ($1, now()), ('breaker:x', now())`,
    [`executor_unhealthy:${DEST}`],
  );

  await runMigrations(tdb.db);
});

afterAll(async () => {
  await tdb.destroy();
  await rm(oldFolder, { recursive: true, force: true });
});

describe('migration 0008: executor → destination', () => {
  it('renames the table and keeps its rows', async () => {
    const rows = await tdb.db.select().from(destinations);
    expect(rows).toMatchObject([{ id: DEST, name: 'Stub', caps: { runsPerHour: 5 } }]);
    const old = await tdb.pool.query(`SELECT to_regclass('public.executors') AS t`);
    expect(old.rows[0]).toEqual({ t: null });
  });

  it('renames executor_id on runs and meter_readings, and the index', async () => {
    const [run] = await tdb.db.select().from(runs).where(eq(runs.id, RUN));
    expect(run).toMatchObject({ destinationId: DEST, statusReason: 'destination_unavailable' });
    const readings = await tdb.db.select().from(meterReadings);
    expect(readings).toMatchObject([{ destinationId: DEST, meterId: 'window' }]);
    const idx = await tdb.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'runs' AND indexname LIKE 'runs_%_invoked'`,
    );
    expect(idx.rows.map((r: { indexname: string }) => r.indexname).sort()).toEqual([
      'runs_destination_invoked',
      'runs_process_invoked',
    ]);
    const cols = await tdb.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%executor%'`,
    );
    expect(cols.rows).toEqual([]);
  });

  it('rewrites process documents and their versions', async () => {
    const [proc] = await tdb.db.select().from(processes).where(eq(processes.id, PROC));
    expect(proc?.document.destination).toEqual({
      instanceId: DEST,
      target: { routine: 'autofix' },
    });
    expect(proc?.document).not.toHaveProperty('executor');
    const [v1] = await tdb.db.select().from(processVersions);
    expect(v1?.document.destination.instanceId).toBe(DEST);
    expect(v1?.document).not.toHaveProperty('executor');
  });

  it('renames the plugin kind and the reference plugin packages', async () => {
    const types = await tdb.db.select().from(pluginTypes);
    expect(types.map((t) => [t.plugin, t.kind, t.typeId]).sort()).toEqual([
      ['@ai-switchboard/destination-http', 'destination', 'http'],
      ['@ai-switchboard/source-webhook', 'source', 'webhook'],
    ]);
    const names = await tdb.db.select().from(plugins);
    expect(names.map((p) => [p.name, p.pluginId]).sort()).toEqual([
      ['@ai-switchboard/destination-http', 'destination-http'],
      ['@ai-switchboard/source-webhook', 'source-webhook'],
    ]);
  });

  it('rewrites audit scopes, process field rows and whole documents', async () => {
    const rows = await tdb.db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows.map((r) => [r.scope, r.field])).toEqual([
      ['destination', 'enabled'],
      ['process', 'destination'],
      ['process', 'restored'],
    ]);
    expect(rows[2]?.before).toHaveProperty('destination');
    expect(rows[2]?.after).not.toHaveProperty('executor');
  });

  it('rewrites hold reasons, trace check names, stats and alert keys', async () => {
    const [b] = await tdb.db.select().from(batches).where(eq(batches.id, BATCH));
    expect(b?.outcomeReason).toBe('destination_unhealthy');
    expect(b?.decisions.map((d) => d.check)).toEqual([
      'destination_enabled',
      'destination_healthy',
    ]);
    const stats = await tdb.db.select().from(statsHourly);
    expect(stats).toMatchObject([{ dimension: 'destination', key: DEST }]);
    const alerts = await tdb.db.select().from(systemAlerts);
    expect(alerts.map((a) => a.key).sort()).toEqual(['breaker:x', `destination_unhealthy:${DEST}`]);
  });
});
