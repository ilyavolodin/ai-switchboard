import { eq, isNotNull } from 'drizzle-orm';

import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { CoreLogger } from '../logger.js';
import { recordAudit } from '../services/audit.js';
import { generatePassword, hashPassword } from './crypto.js';

export const LOCAL_ADMIN_EMAIL = 'admin@switchboard.local';

/**
 * First start: make sure there is a way in.
 *
 * - OIDC configured with `SWITCHBOARD_BOOTSTRAP_ADMIN`: create that admin with no password; they
 *   sign in through the issuer.
 * - Otherwise, when no account has a password yet (and, with OIDC, no admin exists), create a local
 *   admin. A generated password is printed once and must be changed at first sign-in; an explicit
 *   `SWITCHBOARD_ADMIN_PASSWORD` is used as given (automation and e2e rely on it).
 */
export async function bootstrapAdmin(
  db: Db,
  config: CoreConfig,
  logger: CoreLogger,
  now: Date,
  options: { password?: string } = {},
): Promise<{ created: boolean; email?: string; password?: string }> {
  if (config.oidc && config.bootstrapAdmin) {
    const email = config.bootstrapAdmin.toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) return { created: false };
    await db.insert(users).values({ email, role: 'admin', createdAt: now });
    await recordAudit(db, {
      actor: 'system',
      scope: 'user',
      targetId: email,
      field: 'role',
      after: 'admin',
      reason: 'bootstrap admin',
      at: now,
    });
    logger.info({ email }, 'bootstrap admin created; sign in through OIDC');
    return { created: true, email };
  }

  const locals = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.passwordHash))
    .limit(1);
  if (locals.length > 0) return { created: false };
  if (config.oidc) {
    // OIDC without a named bootstrap admin: only step in when nobody could administer the install.
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    if (admins.length > 0) return { created: false };
  }
  const email = (config.bootstrapAdmin ?? LOCAL_ADMIN_EMAIL).toLowerCase();
  const generated = options.password === undefined;
  const password = options.password ?? generatePassword();
  const passwordHash = await hashPassword(password);
  await db
    .insert(users)
    .values({ email, role: 'admin', passwordHash, mustChangePassword: generated, createdAt: now })
    .onConflictDoUpdate({
      target: users.email,
      set: { passwordHash, role: 'admin', mustChangePassword: generated },
    });
  await recordAudit(db, {
    actor: 'system',
    scope: 'user',
    targetId: email,
    field: 'role',
    after: 'admin',
    reason: 'bootstrap local admin',
    at: now,
  });
  if (generated) {
    // Printed once, on the start that creates it; the first sign-in must replace it.
    logger.warn(
      { email },
      `Local admin created: ${email} / temporary password: ${password} (shown once; you will be asked to change it at first sign-in)`,
    );
  }
  return { created: true, email, password };
}
