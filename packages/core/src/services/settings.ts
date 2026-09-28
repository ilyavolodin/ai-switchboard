import { eq } from 'drizzle-orm';

import type { GlobalSettings } from '../api/contract.js';
import type { DbOrTx } from '../db/client.js';
import { settings } from '../db/schema.js';

export const DEFAULT_SETTINGS: GlobalSettings = {
  timezone: 'UTC',
  defaultQuietHours: null,
  meterStalenessMinutes: 30,
  retention: {
    eventsDays: 90,
    rawBodiesDays: 30,
    dispatchesDays: 90,
    meterReadingsDays: 90,
    statsHourlyDays: 730,
  },
  oidc: null,
  systemNotifierId: null,
  sourceSilenceMinutes: 1440,
  requireReasons: true,
  export: { schedule: null, sourceId: null, repository: null, path: null, branch: null },
};

const KEY = 'global';

/** The installation's global settings, merged over defaults. */
export async function getSettings(db: DbOrTx): Promise<GlobalSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, KEY));
  const stored = (rows[0]?.value ?? {}) as Partial<GlobalSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    retention: { ...DEFAULT_SETTINGS.retention, ...stored.retention },
    export: { ...DEFAULT_SETTINGS.export, ...stored.export },
  };
}

export async function putSettings(db: DbOrTx, value: GlobalSettings, now: Date): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}
