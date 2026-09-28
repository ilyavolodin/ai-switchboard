import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../src/logger.js';
import { PgBossQueue } from '../../src/queue/queue.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

async function expiryOf(name: string): Promise<number | undefined> {
  const boss = new PgBoss({ connectionString: tdb.url, schema: 'pgboss' });
  await boss.start();
  try {
    return (await boss.getQueue(name))?.expireInSeconds;
  } finally {
    await boss.stop({ graceful: false });
  }
}

describe('PgBossQueue', () => {
  it('gives long-running workers their expiry, even on a queue created earlier by send()', async () => {
    const q = new PgBossQueue(tdb.url, silentLogger());
    await q.start();
    try {
      await q.send('pipeline.invoke', { runId: 'x' });
      expect(await expiryOf('pipeline.invoke')).toBe(300);
      await q.work('pipeline.invoke', () => Promise.resolve(), { expireInSeconds: 4200 });
      expect(await expiryOf('pipeline.invoke')).toBe(4200);
      await q.work('pipeline.other', () => Promise.resolve());
      expect(await expiryOf('pipeline.other')).toBe(300);
    } finally {
      await q.stop();
    }
  });
});
