import { eq } from 'drizzle-orm';

import { generatePassword } from '../auth/crypto.js';
import { passwordProblem } from '../auth/password-policy.js';
import { emailKey } from '../auth/throttle.js';
import type { Db } from '../db/client.js';
import { loginAttempts, users } from '../db/schema.js';
import type { Role } from '../domain/status.js';
import { recordAudit } from './audit.js';
import { storePassword } from './users.js';

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

export interface RecoveryAudit {
  actor: string;
  reason: string;
  at: Date;
}

export interface SetTemporaryPasswordInput {
  email: string;
  /** Omitted, a password is generated. */
  password?: string;
  audit: RecoveryAudit;
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

/** The CLI prints the message as is. `suggestions` are close existing emails for `unknown_user`. */
export class RecoveryError extends Error {
  override readonly name = 'RecoveryError';
  constructor(
    readonly code: RecoveryErrorCode,
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message);
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

const normalise = (email: string): string => email.trim().toLowerCase();

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

/** Emails are short, so the quadratic table is fine. */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Best first: a small edit distance on the whole address or its local part, the same local part
 * at another domain, or (when nothing is closer) the same domain.
 */
export function closeEmails(email: string, candidates: readonly string[], limit = 5): string[] {
  const wanted = normalise(email);
  const [local = '', domain = ''] = wanted.split('@');
  const scored: { email: string; score: number }[] = [];
  for (const c of candidates) {
    const [cLocal = '', cDomain = ''] = c.split('@');
    const whole = levenshtein(wanted, c);
    const localDistance = levenshtein(local, cLocal);
    const tolerance = Math.max(2, Math.floor(wanted.length / 4));
    let score: number | undefined;
    if (whole <= tolerance) score = whole;
    else if (local !== '' && localDistance <= Math.max(1, Math.floor(local.length / 4)))
      score = 10 + localDistance;
    else if (domain !== '' && cDomain === domain) score = 20 + localDistance;
    if (score !== undefined) scored.push({ email: c, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.email.localeCompare(b.email))
    .slice(0, limit)
    .map((s) => s.email);
}

function checkReason(audit: RecoveryAudit): void {
  if (audit.reason.trim() === '') throw new RecoveryError('no_reason', 'A reason is required.');
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
  checkReason(input.audit);
  const email = normalise(input.email);
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) throw await unknownUser(db, email);
  const [password, generated] = choosePassword(email, input.password);
  await db.transaction(async (tx) => {
    await storePassword(tx, row.id, password, {
      temporary: true,
      field: row.passwordHash === null ? 'password' : 'password_reset',
      audit: input.audit,
    });
  });
  await clearFailures(db, email, row.id);
  return { email, role: row.role, password, generated };
}

/** Break glass: creates the account when missing, promotes it when it exists. */
export async function createAdmin(
  db: Db,
  input: SetTemporaryPasswordInput,
): Promise<TemporaryPasswordResult> {
  checkReason(input.audit);
  const email = normalise(input.email);
  if (!/^[^@\s]+@[^@\s]+$/.test(email))
    throw new RecoveryError('invalid_email', `${input.email} is not a valid email.`);
  const [password, generated] = choosePassword(email, input.password);
  const { actor, reason, at } = input.audit;
  const { change, userId } = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.email, email)).for('update');
    let row = before;
    let change: 'created' | 'promoted' | 'unchanged' = 'unchanged';
    if (!row) {
      [row] = await tx.insert(users).values({ email, role: 'admin', createdAt: at }).returning();
      if (!row) throw new Error('could not create the account');
      change = 'created';
    } else if (row.role !== 'admin') {
      await tx.update(users).set({ role: 'admin' }).where(eq(users.id, row.id));
      change = 'promoted';
    }
    if (change !== 'unchanged') {
      await recordAudit(tx, {
        actor,
        scope: 'user',
        targetId: row.id,
        field: 'role',
        before: before?.role ?? null,
        after: 'admin',
        reason,
        at,
      });
    }
    await storePassword(tx, row.id, password, {
      temporary: true,
      field: before?.passwordHash ? 'password_reset' : 'password',
      audit: input.audit,
    });
    return { change, userId: row.id };
  });
  await clearFailures(db, email, userId);
  return { email, role: 'admin', password, generated, change };
}
