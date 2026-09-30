import { and, eq, isNotNull } from 'drizzle-orm';

import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { passwordProblem } from '../auth/password-policy.js';
import { revokeUserSessions } from '../auth/sessions.js';
import type { Db, DbOrTx } from '../db/client.js';
import { apiTokens, users } from '../db/schema.js';
import type { Role } from '../domain/status.js';
import { isEmail, normaliseEmail } from '../util/emails.js';
import { auditChange, type ChangeMeta } from './audit.js';
import { badRequest, conflict, DomainError, notFound } from './errors.js';

export type UserRow = typeof users.$inferSelect;

/** `temporary` (an admin or bootstrap chose it) makes the next password sign-in change it. */
async function storePassword(
  db: DbOrTx,
  userId: string,
  password: string,
  options: { temporary: boolean; keepToken?: string; field: string; meta: ChangeMeta },
): Promise<UserRow | undefined> {
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(users)
    .set({ passwordHash, mustChangePassword: options.temporary })
    .where(eq(users.id, userId))
    .returning();
  if (!row) return undefined;
  await revokeUserSessions(db, userId, options.keepToken);
  await auditChange(db, options.meta, {
    scope: 'user',
    targetId: userId,
    field: options.field,
    // Record what happened, never the value.
    after: options.temporary ? 'temporary' : 'set',
  });
  return row;
}

/** A password someone else chose for the account (an admin, the CLI): changed at next sign-in. */
export function storeTemporaryPassword(
  db: DbOrTx,
  user: Pick<UserRow, 'id' | 'passwordHash'>,
  password: string,
  meta: ChangeMeta,
): Promise<UserRow | undefined> {
  return storePassword(db, user.id, password, {
    temporary: true,
    field: user.passwordHash === null ? 'password' : 'password_reset',
    meta,
  });
}

export async function getUser(db: DbOrTx, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

async function requireUser(db: DbOrTx, id: string): Promise<UserRow> {
  const row = await getUser(db, id);
  if (!row) throw notFound('User');
  return row;
}

/** Only an account that has a password can sign in with one. */
export async function findPasswordUser(db: DbOrTx, email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.passwordHash)));
  return row;
}

/**
 * Refuse (409) unless another admin remains. Locks the admin rows, so two admins demoting or
 * removing each other at the same moment cannot both succeed.
 */
async function keepAnotherAdmin(tx: DbOrTx, message: string): Promise<void> {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .for('update');
  if (admins.length <= 1) throw conflict(message);
}

function checkPassword(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw badRequest(problem);
}

export async function createUser(
  db: Db,
  input: { email: string; role: Role; password?: string | undefined },
  meta: ChangeMeta,
): Promise<UserRow> {
  const email = normaliseEmail(input.email);
  if (!isEmail(email)) throw badRequest('A valid email is required.');
  const { password } = input;
  if (password !== undefined) checkPassword(password, email);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) throw conflict(`${email} already has access.`);
  return db.transaction(async (tx) => {
    const [r] = await tx
      .insert(users)
      .values({ email, role: input.role, createdAt: meta.now })
      .returning();
    if (!r) throw new Error('user insert returned no row');
    await auditChange(tx, meta, {
      scope: 'user',
      targetId: r.id,
      field: 'role',
      after: input.role,
    });
    if (password === undefined) return r;
    return (await storeTemporaryPassword(tx, r, password, meta)) ?? r;
  });
}

export async function changeUserRole(
  db: Db,
  id: string,
  role: Role,
  meta: ChangeMeta,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const before = await requireUser(tx, id);
    if (before.role === 'admin' && role !== 'admin')
      await keepAnotherAdmin(tx, 'This is the last admin; add another admin first.');
    const [row] = await tx.update(users).set({ role }).where(eq(users.id, before.id)).returning();
    if (!row) throw notFound('User');
    await auditChange(tx, meta, {
      scope: 'user',
      targetId: before.id,
      field: 'role',
      before: before.role,
      after: role,
    });
    return row;
  });
}

/** Sessions end and API tokens are revoked with the account. */
export async function deleteUser(
  db: Db,
  id: string,
  requesterId: string | undefined,
  meta: ChangeMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await requireUser(tx, id);
    if (before.id === requesterId) throw conflict('You cannot remove yourself.');
    if (before.role === 'admin') await keepAnotherAdmin(tx, 'This is the last admin.');
    await revokeUserSessions(tx, before.id);
    await tx.update(apiTokens).set({ revokedAt: meta.now }).where(eq(apiTokens.userId, before.id));
    await tx.delete(users).where(eq(users.id, before.id));
    await auditChange(tx, meta, {
      scope: 'user',
      targetId: before.id,
      field: 'deleted',
      before: { email: before.email, role: before.role },
    });
  });
}

/** An admin sets or resets someone else's password; it is temporary. */
export async function setTemporaryPassword(
  db: Db,
  id: string,
  password: string,
  requesterId: string | undefined,
  meta: ChangeMeta,
): Promise<UserRow> {
  const before = await requireUser(db, id);
  if (before.id === requesterId)
    throw conflict('Change your own password from your account, not the Users tab.');
  checkPassword(password, before.email);
  const row = await db.transaction((tx) => storeTemporaryPassword(tx, before, password, meta));
  if (!row) throw notFound('User');
  return row;
}

/** Refused without OIDC: the account could not sign in at all. */
export async function removeUserPassword(
  db: Db,
  id: string,
  oidcConfigured: boolean,
  meta: ChangeMeta,
): Promise<UserRow> {
  const before = await requireUser(db, id);
  if (before.passwordHash === null) throw conflict(`${before.email} has no password.`);
  if (!oidcConfigured)
    throw conflict('OIDC is not configured; without a password this account could not sign in.');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ passwordHash: null, mustChangePassword: false })
      .where(eq(users.id, before.id))
      .returning();
    if (!updated) return undefined;
    await revokeUserSessions(tx, before.id);
    await auditChange(tx, meta, {
      scope: 'user',
      targetId: before.id,
      field: 'password',
      before: 'set',
      after: 'removed',
    });
    return updated;
  });
  if (!row) throw notFound('User');
  return row;
}

export async function revokeSessionsOf(db: Db, id: string, meta: ChangeMeta): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await requireUser(tx, id);
    await revokeUserSessions(tx, row.id);
    await auditChange(tx, meta, { scope: 'user', targetId: row.id, field: 'sessions_revoked' });
  });
}

export class InvalidCurrentPasswordError extends DomainError {
  constructor() {
    // 400, not 401: the session is fine, only the confirmation failed.
    super('bad_request', 'The current password is incorrect.', { code: 'invalid_credentials' });
  }
}

/**
 * The signed-in user changes their own password. `onCurrentChecked` hears whether the current
 * password matched before anything is refused, so the caller can count attempts. The current
 * session (`keepToken`) survives.
 */
export async function changeOwnPassword(
  db: Db,
  userId: string,
  input: { currentPassword: string; newPassword: string; keepToken: string },
  meta: ChangeMeta,
  onCurrentChecked: (ok: boolean) => Promise<void>,
): Promise<UserRow> {
  const row = await getUser(db, userId);
  if (!row?.passwordHash) throw conflict('This account has no password; ask an admin to set one.');
  const ok = await verifyPassword(input.currentPassword, row.passwordHash);
  await onCurrentChecked(ok);
  if (!ok) throw new InvalidCurrentPasswordError();
  checkPassword(input.newPassword, row.email);
  if (input.newPassword === input.currentPassword)
    throw badRequest('Choose a password different from the current one.');
  const updated = await db.transaction((tx) =>
    storePassword(tx, row.id, input.newPassword, {
      temporary: false,
      keepToken: input.keepToken,
      field: 'password',
      meta,
    }),
  );
  return updated ?? row;
}

export class OidcIdentityMismatchError extends DomainError {
  constructor() {
    super('conflict', 'This account is linked to a different identity; ask an admin.');
  }
}

/**
 * The account for an OIDC sign-in, bound to the issuer's subject on first use (audited). An email
 * already bound to another subject is refused, never re-bound silently, and an unverified email
 * never binds an account that has a password. Undefined: no account.
 */
export async function userForOidcIdentity(
  db: Db,
  identity: { email: string; subject: string; emailVerified: boolean },
  now: Date,
): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, identity.email));
  if (!row) return undefined;
  if (row.oidcSubject !== null && row.oidcSubject !== identity.subject)
    throw new OidcIdentityMismatchError();
  if (row.oidcSubject !== null) return row;
  if (!identity.emailVerified && row.passwordHash !== null)
    throw conflict(
      'This account has a password and the issuer did not verify your email; sign in with the password.',
    );
  return db.transaction(async (tx) => {
    const [bound] = await tx
      .update(users)
      .set({ oidcSubject: identity.subject })
      .where(eq(users.id, row.id))
      .returning();
    await auditChange(
      tx,
      { actor: row.email, reason: 'first OIDC sign-in', now },
      {
        scope: 'user',
        targetId: row.id,
        field: 'oidc_subject',
        before: null,
        after: identity.subject,
      },
    );
    return bound ?? row;
  });
}

/**
 * The account for an email and password, or undefined. `decoyHash` is compared against when the
 * email has no password, so a miss costs as long as a wrong password and the response time does
 * not tell which emails have accounts.
 */
export async function passwordLogin(
  db: DbOrTx,
  email: string,
  password: string,
  decoyHash: () => Promise<string>,
): Promise<UserRow | undefined> {
  const row = await findPasswordUser(db, email);
  const ok = await verifyPassword(password, row?.passwordHash ?? (await decoyHash()));
  return row && ok ? row : undefined;
}
