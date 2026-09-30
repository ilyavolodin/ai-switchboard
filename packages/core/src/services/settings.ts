import { randomBytes } from 'node:crypto';

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
const COOKIE_KEY = 'cookie_key';

export async function getSettings(db: DbOrTx): Promise<GlobalSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, KEY));
  const stored = (rows[0]?.value ?? {}) as Partial<GlobalSettings>;
  return mergeSettings(DEFAULT_SETTINGS, stored);
}

/** Unaudited: for seeding (tests, bootstrap); a person's change goes through `writeSettings`. */
export async function putSettings(db: DbOrTx, value: GlobalSettings, now: Date): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/** Stores `after` in the caller's transaction; one audit row per top-level field that changed. */
export async function writeSettings(
  tx: DbOrTx,
  before: GlobalSettings,
  after: GlobalSettings,
  meta: ChangeMeta,
): Promise<void> {
  await putSettings(tx, after, meta.now);
  await recordAuditDiff(
    tx,
    { actor: meta.actor, scope: 'settings', targetId: KEY, reason: meta.reason, at: meta.now },
    { ...before },
    { ...after },
  );
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
    await writeSettings(tx, before, after, meta);
    return after;
  });
}

/**
 * The key that signs cookies, shared by every replica so an OIDC flow can finish on any of them.
 * The first replica to boot creates it.
 */
export async function sharedCookieKey(db: DbOrTx, now: Date): Promise<string> {
  await db
    .insert(settings)
    .values({ key: COOKIE_KEY, value: randomBytes(32).toString('base64url'), updatedAt: now })
    .onConflictDoNothing();
  const [row] = await db.select().from(settings).where(eq(settings.key, COOKIE_KEY));
  if (typeof row?.value !== 'string' || row.value === '') {
    throw new Error('the shared cookie key is missing from settings');
  }
  return row.value;
}
