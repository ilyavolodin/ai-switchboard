import { eq } from 'drizzle-orm';

import { generatePassword } from '../auth/crypto.js';
import { passwordProblem } from '../auth/password-policy.js';
import { emailKey } from '../auth/throttle.js';
import type { Db } from '../db/client.js';
import { loginAttempts, users } from '../db/schema.js';
import type { Role } from '../domain/status.js';
import { closeEmails, isEmail, normaliseEmail } from '../util/emails.js';
import { auditChange, type ChangeMeta } from './audit.js';
import { DomainError, type ErrorKind } from './errors.js';
import { storeTemporaryPassword } from './users.js';

/**
 * Account recovery for `switchboard users ...`. It talks to Postgres directly, so it works when
 * nobody can sign in; server access is the credential.
 */

/** Never includes a password hash. */
export interface AccountSummary {
  email: string;
  role: Role;
  hasPassword: boolean;
  hasOidc: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SetTemporaryPasswordInput {
  email: string;
  /** Omitted, a password is generated. */
  password?: string;
  meta: ChangeMeta;
}

export interface TemporaryPasswordResult {
  email: string;
  role: Role;
  /** Show once; never stored or logged. */
  password: string;
  generated: boolean;
  /** Set by `createAdmin`. */
  change?: 'created' | 'promoted' | 'unchanged';
}

export type RecoveryErrorCode = 'unknown_user' | 'invalid_password' | 'invalid_email' | 'no_reason';

const KIND_OF: Readonly<Record<RecoveryErrorCode, ErrorKind>> = {
  unknown_user: 'not_found',
  invalid_password: 'bad_request',
  invalid_email: 'bad_request',
  no_reason: 'bad_request',
};

/** The CLI prints the message as is. `suggestions` are close existing emails for `unknown_user`. */
export class RecoveryError extends DomainError {
  override readonly name = 'RecoveryError';
  declare readonly code: RecoveryErrorCode;

  constructor(
    code: RecoveryErrorCode,
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(KIND_OF[code], message, { code });
  }
}

export function isRecoveryError(err: unknown): err is RecoveryError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'RecoveryError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function toSummary(row: typeof users.$inferSelect): AccountSummary {
  return {
    email: row.email,
    role: row.role,
    hasPassword: row.passwordHash !== null,
    hasOidc: row.oidcSubject !== null,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAccounts(db: Db): Promise<AccountSummary[]> {
  return (await db.select().from(users).orderBy(users.email)).map(toSummary);
}

function checkReason(meta: ChangeMeta): void {
  if (meta.reason.trim() === '') throw new RecoveryError('no_reason', 'A reason is required.');
}

function choosePassword(email: string, password: string | undefined): [string, boolean] {
  if (password === undefined) return [generatePassword(), true];
  const problem = passwordProblem(password, email);
  if (problem) throw new RecoveryError('invalid_password', problem);
  return [password, false];
}

async function unknownUser(db: Db, email: string): Promise<RecoveryError> {
  const all = await db.select({ email: users.email }).from(users);
  const suggestions = closeEmails(
    email,
    all.map((r) => r.email),
  );
  return new RecoveryError('unknown_user', `No account has the email ${email}.`, suggestions);
}

async function clearFailures(db: Db, email: string, userId: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.key, emailKey(email)));
  await db.delete(loginAttempts).where(eq(loginAttempts.key, `password:${userId}`));
}

export async function resetPassword(
  db: Db,
  input: SetTemporaryPasswordInput,
): Promise<TemporaryPasswordResult> {
  checkReason(input.meta);
  const email = normaliseEmail(input.email);
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) throw await unknownUser(db, email);
  const [password, generated] = choosePassword(email, input.password);
  await db.transaction((tx) => storeTemporaryPassword(tx, row, password, input.meta));
  await clearFailures(db, email, row.id);
  return { email, role: row.role, password, generated };
}

/** Break glass: creates the account when missing, promotes it when it exists. */
export async function createAdmin(
  db: Db,
  input: SetTemporaryPasswordInput,
): Promise<TemporaryPasswordResult> {
  checkReason(input.meta);
  const email = normaliseEmail(input.email);
  if (!isEmail(email))
    throw new RecoveryError('invalid_email', `${input.email} is not a valid email.`);
  const [password, generated] = choosePassword(email, input.password);
  const { meta } = input;
  const { change, userId } = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.email, email)).for('update');
    let row = before;
    let change: 'created' | 'promoted' | 'unchanged' = 'unchanged';
    if (!row) {
      [row] = await tx
        .insert(users)
        .values({ email, role: 'admin', createdAt: meta.now })
        .returning();
      if (!row) throw new Error('could not create the account');
      change = 'created';
    } else if (row.role !== 'admin') {
      await tx.update(users).set({ role: 'admin' }).where(eq(users.id, row.id));
      change = 'promoted';
    }
    if (change !== 'unchanged') {
      await auditChange(tx, meta, {
        scope: 'user',
        targetId: row.id,
        field: 'role',
        before: before?.role ?? null,
        after: 'admin',
      });
    }
    await storeTemporaryPassword(tx, row, password, meta);
    return { change, userId: row.id };
  });
  await clearFailures(db, email, userId);
  return { email, role: 'admin', password, generated, change };
}
