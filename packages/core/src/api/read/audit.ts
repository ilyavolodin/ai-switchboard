import { desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { isOneOf } from '@ai-switchboard/sdk';

import type { AuditEntry, AuditQuery, Page } from '../../contract/index.js';
import { selectFromEachInstanceTable } from '../../db/instance-tables.js';
import { auditLog, processes, users } from '../../db/schema.js';
import { AUDIT_SCOPES, INSTANCE_KINDS } from '../../domain/status.js';
import { isUuid } from '../../util/uuid.js';
import type { ReadDeps } from './deps.js';
import { keysetPage } from './paging.js';

type AuditRow = typeof auditLog.$inferSelect;

/** id → display name for the audit rows on one page, across instances, users and processes. */
async function targetNames(
  ctx: ReadDeps,
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
    selectFromEachInstanceTable(INSTANCE_KINDS, (t) =>
      ctx.db.select({ id: t.id, name: t.name }).from(t).where(inArray(t.id, ids)),
    ),
    ctx.db.select({ id: users.id, name: users.email }).from(users).where(inArray(users.id, ids)),
  ]);
  for (const list of lists) for (const r of list) out.set(r.id, r.name);
  return out;
}

/** Newest first, paged by `(at, id)`. The actor filter is a substring match with literal wildcards. */
export async function listAudit(ctx: ReadDeps, q: AuditQuery): Promise<Page<AuditEntry>> {
  const where: SQL[] = [];
  // An unknown scope matches nothing, as it did when the column was untyped.
  if (q.scope)
    where.push(isOneOf(AUDIT_SCOPES, q.scope) ? eq(auditLog.scope, q.scope) : sql`false`);
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
