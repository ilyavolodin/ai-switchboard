import { desc, eq } from 'drizzle-orm';

import { createApiToken, type AuthUser } from '../auth/sessions.js';
import type { Db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';
import { roleAtLeast, type Role } from '../domain/status.js';
import { auditChange, type ChangeMeta } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';

export type TokenRow = typeof apiTokens.$inferSelect;

export async function tokensOf(db: Db, userId: string): Promise<TokenRow[]> {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

/** A token never has more than its owner's role. The secret is returned once and never stored. */
export async function createToken(
  db: Db,
  owner: Pick<AuthUser, 'id' | 'role'>,
  input: { name?: string | undefined; role: Role },
  meta: ChangeMeta,
): Promise<{ row: TokenRow; secret: string }> {
  if (!roleAtLeast(owner.role, input.role))
    throw badRequest(`A token cannot have more than your own role (${owner.role}).`);
  const name = input.name?.trim() ? input.name.trim().slice(0, 80) : 'token';
  return db.transaction(async (tx) => {
    const created = await createApiToken(tx, owner.id, name, input.role, meta.now);
    await auditChange(tx, meta, {
      scope: 'token',
      targetId: created.id,
      field: 'created',
      after: { name, role: input.role },
    });
    const [row] = await tx.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    if (!row) throw new Error('token not found after insert');
    return { row, secret: created.secret };
  });
}

/** Your own tokens, or anyone's as an admin. */
export async function revokeToken(
  db: Db,
  id: string,
  requester: Pick<AuthUser, 'id' | 'role'> | null,
  meta: ChangeMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(apiTokens).where(eq(apiTokens.id, id)).for('update');
    if (!row) throw notFound('Token');
    if (row.userId !== requester?.id && requester?.role !== 'admin')
      throw forbidden('You can only revoke your own tokens.');
    await tx.update(apiTokens).set({ revokedAt: meta.now }).where(eq(apiTokens.id, row.id));
    await auditChange(tx, meta, { scope: 'token', targetId: row.id, field: 'revoked' });
  });
}
