import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../db/client.js';

export async function databaseReachable(db: DbOrTx): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
