import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processes } from '../../src/db/schema.js';
import { defaultProcessDocument } from '../../src/domain/process.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

describe('database', () => {
  it('migrates and round-trips a process document', async () => {
    const doc = defaultProcessDocument('Autofix', '00000000-0000-4000-8000-000000000000');
    const [row] = await tdb.db
      .insert(processes)
      .values({ name: doc.name, document: doc })
      .returning();
    expect(row?.document.batching.debounceSeconds).toBe(30);
    expect(row?.breakerState).toBe('closed');
  });
});
