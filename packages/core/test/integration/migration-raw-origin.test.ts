import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../../src/db/client.js';
import { eventRaw } from '../../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';

let tdb: TestDatabase;
let oldFolder: string;

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

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  oldFolder = await migrationsUpTo(9);
  await migrate(tdb.db, { migrationsFolder: oldFolder });
  const insert = (ref: string, headers: Record<string, string>) =>
    tdb.pool.query(
      `INSERT INTO event_raw (ref, source_id, body, headers, received_at)
       VALUES ($1, $2, '\\x7b7d', $3, now())`,
      [ref, SOURCE, headers],
    );
  await insert('a-push', { 'x-event-type': 'issue.created' });
  await insert('b-poll', { 'x-switchboard-origin': 'poll' });
  await insert('c-test', { 'x-switchboard-origin': 'test', 'x-extra': '1' });
  await runMigrations(tdb.db);
});

afterAll(async () => {
  await tdb.destroy();
  await rm(oldFolder, { recursive: true, force: true });
});

describe('migration 0010', () => {
  it('moves the origin pseudo-header into its own column', async () => {
    const rows = await tdb.db.select().from(eventRaw).orderBy(asc(eventRaw.ref));
    expect(rows.map((r) => [r.ref, r.origin, r.headers])).toEqual([
      ['a-push', 'push', { 'x-event-type': 'issue.created' }],
      ['b-poll', 'poll', {}],
      ['c-test', 'test', { 'x-extra': '1' }],
    ]);
  });
});
