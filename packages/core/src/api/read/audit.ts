import { desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { INSTANCE_TABLES } from '../../db/instance-tables.js';
import { auditLog, processes, users } from '../../db/schema.js';
import { INSTANCE_KINDS } from '../../domain/status.js';
import { isUuid } from '../../util/uuid.js';
import type { ApiContext } from '../context.js';
import type { AuditEntry, AuditQuery, Page } from '../contract.js';
import { keysetPage } from './paging.js';

type AuditRow = typeof auditLog.$inferSelect;

/** id → display name for the audit rows on one page, across instances, users and processes. */
async function targetNames(
  ctx: ApiContext,
  targetIds: (string | null)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Plugin names, `global` and bootstrap emails are not row ids.
  const ids = [...new Set(targetIds.filter((id): id is string => isUuid(id)))];
  if (ids.length === 0) return out;
  const lists = await Promise.all([
    ctx.db
      .select({ id: processes.id, name: processes.name })
      .from(processes)
      .where(inArray(processes.id, ids)),
    ...INSTANCE_KINDS.map((kind) => {
      const t = INSTANCE_TABLES[kind];
      return ctx.db.select({ id: t.id, name: t.name }).from(t).where(inArray(t.id, ids));
    }),
    ctx.db.select({ id: users.id, name: users.email }).from(users).where(inArray(users.id, ids)),
  ]);
  for (const list of lists) for (const r of list) out.set(r.id, r.name);
  return out;
}

/** Newest first, paged by `(at, id)`. The actor filter is a substring match with literal wildcards. */
export async function listAudit(ctx: ApiContext, q: AuditQuery): Promise<Page<AuditEntry>> {
  const where: SQL[] = [];
  if (q.scope) where.push(eq(auditLog.scope, q.scope));
  if (q.target) where.push(eq(auditLog.targetId, q.target));
  if (q.actor) {
    const escaped = q.actor.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push(sql`${auditLog.actor} ILIKE ${`%${escaped}%`}`);
  }
  return keysetPage(
    q,
    { time: auditLog.at, id: auditLog.id, keyOf: (r: AuditRow) => ({ t: r.at, id: String(r.id) }) },
    where,
    (cond, take) =>
      ctx.db
        .select()
        .from(auditLog)
        .where(cond)
        .orderBy(desc(auditLog.at), desc(auditLog.id))
        .limit(take),
    async (rows) => {
      const names = await targetNames(
        ctx,
        rows.map((r) => r.targetId),
      );
      return rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor,
        scope: r.scope,
        targetId: r.targetId,
        targetName: r.targetId ? (names.get(r.targetId) ?? null) : null,
        field: r.field,
        before: r.before,
        after: r.after,
        reason: r.reason,
      }));
    },
  );
}
