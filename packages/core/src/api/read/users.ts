import { users } from '../../db/schema.js';
import type { TokenRow } from '../../services/tokens.js';
import type { UserRow } from '../../services/users.js';
import type { ApiContext } from '../context.js';
import type { ApiTokenDTO, UserDirectoryEntry, UserDTO } from '../contract.js';

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    hasPassword: row.passwordHash !== null,
    hasOidc: row.oidcSubject !== null,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toTokenDTO(row: TokenRow): ApiTokenDTO {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function userList(ctx: ApiContext): Promise<UserDTO[]> {
  return (await ctx.db.select().from(users).orderBy(users.email)).map(toUserDTO);
}

/** Who has access and with which role, for every role; how and when they sign in is admin-only. */
export async function userDirectory(ctx: ApiContext): Promise<UserDirectoryEntry[]> {
  return ctx.db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .orderBy(users.email);
}
