import { eq } from 'drizzle-orm';

import { hashPassword } from '../auth/crypto.js';
import { revokeUserSessions } from '../auth/sessions.js';
import type { DbOrTx } from '../db/client.js';
import { users } from '../db/schema.js';
import { recordAudit } from './audit.js';

/** Who did it and why, for the audit row. The password itself is never audited or logged. */
export interface PasswordChangeAudit {
  actor: string;
  reason: string;
  at: Date;
}

/**
 * Store a new password for `userId` and sign the user out of every session except `keepToken`.
 * `temporary` (an admin or bootstrap chose it) makes the next password sign-in change it.
 */
export async function storePassword(
  db: DbOrTx,
  userId: string,
  password: string,
  options: { temporary: boolean; keepToken?: string; field: string; audit: PasswordChangeAudit },
): Promise<typeof users.$inferSelect | undefined> {
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(users)
    .set({ passwordHash, mustChangePassword: options.temporary })
    .where(eq(users.id, userId))
    .returning();
  if (!row) return undefined;
  await revokeUserSessions(db, userId, options.keepToken);
  await recordAudit(db, {
    actor: options.audit.actor,
    scope: 'user',
    targetId: userId,
    field: options.field,
    // Record what happened, never the value.
    after: options.temporary ? 'temporary' : 'set',
    reason: options.audit.reason,
    at: options.audit.at,
  });
  return row;
}

/** Remove the local password (the account becomes OIDC-only) and sign the user out everywhere. */
export async function removePassword(
  db: DbOrTx,
  userId: string,
  audit: PasswordChangeAudit,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db
    .update(users)
    .set({ passwordHash: null, mustChangePassword: false })
    .where(eq(users.id, userId))
    .returning();
  if (!row) return undefined;
  await revokeUserSessions(db, userId);
  await recordAudit(db, {
    actor: audit.actor,
    scope: 'user',
    targetId: userId,
    field: 'password',
    before: 'set',
    after: 'removed',
    reason: audit.reason,
    at: audit.at,
  });
  return row;
}
