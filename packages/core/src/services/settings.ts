import { validateAgainst } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';

import { settingsPatchSchema } from '../contract/admin.js';
import type { Db, DbOrTx } from '../db/client.js';
import { settings } from '../db/schema.js';
import { DEFAULT_SETTINGS, mergeSettings, type GlobalSettings } from '../domain/settings.js';
import { recordAuditDiff, type ChangeMeta } from './audit.js';
import { badRequest } from './errors.js';

export { DEFAULT_SETTINGS } from '../domain/settings.js';

const KEY = 'global';

export async function getSettings(db: DbOrTx): Promise<GlobalSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, KEY));
  const stored = (rows[0]?.value ?? {}) as Partial<GlobalSettings>;
  return mergeSettings(DEFAULT_SETTINGS, stored);
}

export async function putSettings(db: DbOrTx, value: GlobalSettings, now: Date): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merges a partial change into the stored settings; one audit row per changed field. */
export async function updateSettings(
  db: Db,
  patch: unknown,
  meta: ChangeMeta,
): Promise<GlobalSettings> {
  const copy = structuredClone(patch);
  const check = validateAgainst(settingsPatchSchema, copy);
  if (!check.valid) throw badRequest('Settings are invalid.', check.errors);
  const change = copy as Partial<GlobalSettings>;
  if (change.timezone !== undefined && !isTimezone(change.timezone))
    throw badRequest(`Unknown timezone ${change.timezone}`);
  return db.transaction(async (tx) => {
    const before = await getSettings(tx);
    const after = mergeSettings(before, change);
    await putSettings(tx, after, meta.now);
    await recordAuditDiff(
      tx,
      {
        actor: meta.actor,
        scope: 'settings',
        targetId: 'global',
        reason: meta.reason,
        at: meta.now,
      },
      { ...before },
      { ...after },
    );
    return after;
  });
}
