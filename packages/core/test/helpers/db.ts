import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import { connect, runMigrations, type Database } from '../../src/db/client.js';

export interface TestDatabase extends Database {
  url: string;
  /** Drop the per-file database. */
  destroy(): Promise<void>;
}

/**
 * A fresh, migrated database for one test file. `migrate: false` leaves it empty, for a test that
 * applies migrations itself (e.g. an upgrade from an earlier schema).
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const baseUrl = inject('databaseUrl');
  const name = `sb_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const database = connect(url.toString(), { max: 5 });
  if (options.migrate !== false) await runMigrations(database.db);
  return {
    ...database,
    url: url.toString(),
    destroy: async () => {
      await database.close();
      const a = new pg.Client({ connectionString: baseUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
