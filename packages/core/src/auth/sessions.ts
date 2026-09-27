import { and, eq, isNull, lt } from 'drizzle-orm';

import type { DbOrTx } from '../db/client.js';
import { apiTokens, sessions, users } from '../db/schema.js';
import type { Role } from '../domain/status.js';
import { randomToken, roleAtLeast, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'sb_session';
/** 12-hour sliding lifetime. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** `session` or `token:<name>` */
  via: string;
}

export async function createSession(db: DbOrTx, userId: string, now: Date): Promise<string> {
  const token = randomToken('sbs_');
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    lastSeenAt: now,
  });
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return token;
}

/** The session's user, sliding the expiry forward; null when missing or expired. */
export async function userForSession(
  db: DbOrTx,
  token: string,
  now: Date,
): Promise<AuthUser | null> {
  const hash = sha256(token);
  const rows = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hash));
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hash));
    return null;
  }
  // Slide at most once a minute to keep writes low.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.tokenHash, hash));
  }
  return { id: row.user.id, email: row.user.email, role: row.user.role, via: 'session' };
}

export async function revokeSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeUserSessions(db: DbOrTx, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function pruneSessions(db: DbOrTx, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

export async function createApiToken(
  db: DbOrTx,
  userId: string,
  name: string,
  role: Role,
  now: Date,
): Promise<{ id: string; secret: string }> {
  const secret = randomToken('sbt_');
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, name, role, tokenHash: sha256(secret), createdAt: now })
    .returning({ id: apiTokens.id });
  if (!row) throw new Error('could not create token');
  return { id: row.id, secret };
}

/** A personal API token's user, with the token's role capped at the user's current role. */
export async function userForApiToken(
  db: DbOrTx,
  secret: string,
  now: Date,
): Promise<AuthUser | null> {
  const rows = await db
    .select({ user: users, token: apiTokens })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(secret)), isNull(apiTokens.revokedAt)));
  const row = rows[0];
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
  const role = roleAtLeast(row.user.role, row.token.role) ? row.token.role : row.user.role;
  return { id: row.user.id, email: row.user.email, role, via: `token:${row.token.name}` };
}
