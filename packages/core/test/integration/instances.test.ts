import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instanceState, sources } from '../../src/db/schema.js';
import type { ChangeMeta } from '../../src/services/audit.js';
import {
  createInstance,
  deleteInstance,
  updateInstance,
  type InstanceDeps,
} from '../../src/services/instances.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
let h: ApiHarness;

beforeAll(async () => {
  process.env.TEST_SOURCE_SECRET = 's-fixture-secret';
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb);
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

const meta = (): ChangeMeta => ({ actor: 'tester', reason: 'instances test', now: h.clock.now() });

type Probe = InstanceDeps['host']['buildPreviewSource'];

function deps(probe?: Probe): InstanceDeps {
  return {
    db: tdb.db,
    runtime: h.host,
    host: {
      buildPreviewSource: probe ?? ((...args) => h.host.buildPreviewSource(...args)),
      reloadDependentsOf: (names) => h.host.reloadDependentsOf(names),
    },
  };
}

async function newSource(name: string): Promise<string> {
  const row = await createInstance(
    deps(),
    'source',
    { typeId: 'test-source', name, settings: { secret: 'secret://env/TEST_SOURCE_SECRET' } },
    meta(),
  );
  return row.id;
}

describe('instance writes', () => {
  it('keeps a change another request saved while this one was being checked', async () => {
    const id = await newSource('Racing — before');
    let raced = false;
    const racingProbe: Probe = async (...args) => {
      if (!raced) {
        raced = true;
        await tdb.db.update(sources).set({ name: 'Racing — renamed' }).where(eq(sources.id, id));
      }
      return h.host.buildPreviewSource(...args);
    };
    await updateInstance(deps(racingProbe), 'source', id, { caps: { eventCapPerHour: 5 } }, meta());
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, id));
    expect(row).toMatchObject({ name: 'Racing — renamed', caps: { eventCapPerHour: 5 } });
  });

  it('deletes the instance state a plugin kept, with the instance', async () => {
    const id = await newSource('Stateful');
    await tdb.db
      .insert(instanceState)
      .values({ instanceId: id, key: 'refresh_token', value: 'fixture-secret' });
    await deleteInstance(deps(), 'source', id, meta());
    expect(
      await tdb.db.select().from(instanceState).where(eq(instanceState.instanceId, id)),
    ).toEqual([]);
  });
});
