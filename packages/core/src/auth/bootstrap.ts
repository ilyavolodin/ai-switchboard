import { eq, isNotNull } from 'drizzle-orm';

import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { CoreLogger } from '../logger.js';
import { recordAudit } from '../services/audit.js';
import { generatePassword, hashPassword } from './crypto.js';

export const LOCAL_ADMIN_EMAIL = 'admin@switchboard.local';

/**
 * First start: with OIDC, create the admin named by `SWITCHBOARD_BOOTSTRAP_ADMIN`; without OIDC,
 * create a local admin and print its password once (or use `SWITCHBOARD_ADMIN_PASSWORD`).
 */
export async function bootstrapAdmin(
  db: Db,
  config: CoreConfig,
  logger: CoreLogger,
  now: Date,
  options: { password?: string } = {},
): Promise<{ created: boolean; email?: string; password?: string }> {
  if (config.oidc) {
    const email = config.bootstrapAdmin?.toLowerCase();
    if (!email) return { created: false };
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
  const email = (config.bootstrapAdmin ?? LOCAL_ADMIN_EMAIL).toLowerCase();
  const password = options.password ?? generatePassword();
  const passwordHash = await hashPassword(password);
  await db
    .insert(users)
    .values({ email, role: 'admin', passwordHash, createdAt: now })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash, role: 'admin' } });
  await recordAudit(db, {
    actor: 'system',
    scope: 'user',
    targetId: email,
    field: 'role',
    after: 'admin',
    reason: 'bootstrap local admin',
    at: now,
  });
  if (options.password === undefined) {
    // Printed once, on the start that creates it. OIDC is the production path.
    logger.warn(
      { email },
      `OIDC is not configured. Local admin created: ${email} / password: ${password} (shown once; configure OIDC for production)`,
    );
  }
  return { created: true, email, password };
}
