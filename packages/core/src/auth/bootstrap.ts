import { and, eq, isNotNull } from 'drizzle-orm';

import type { CoreConfig } from '../config.js';
import type { Db, DbOrTx } from '../db/client.js';
import { users } from '../db/schema.js';
import type { CoreLogger } from '../logger.js';
import { recordAudit } from '../services/audit.js';
import { LOCAL_ONLY } from '../telemetry/log-bridge.js';

import { generatePassword, hashPassword } from './crypto.js';

export const LOCAL_ADMIN_EMAIL = 'admin@switchboard.local';

/** Null outside evaluation mode, so a production install never reveals an email to a stranger. */
export async function evaluationAdminEmail(
  db: DbOrTx,
  config: Pick<CoreConfig, 'evaluation' | 'bootstrapAdmin'>,
): Promise<string | null> {
  if (!config.evaluation) return null;
  const email = (config.bootstrapAdmin ?? LOCAL_ADMIN_EMAIL).toLowerCase();
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.passwordHash)));
  return row ? email : null;
}

/**
 * With OIDC and a named bootstrap admin, creates that admin with no password. Otherwise, when no
 * account has a password (and, with OIDC, no admin exists), creates a local admin. An explicit
 * `SWITCHBOARD_ADMIN_PASSWORD` is used as given and need not be changed (automation relies on it).
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
    // Stdout only: never exported to an OpenTelemetry backend.
    logger.warn(
      { email, [LOCAL_ONLY]: true },
      `Local admin created: ${email} / temporary password: ${password} (shown once; you will be asked to change it at first sign-in)`,
    );
  }
  return { created: true, email, password };
}
