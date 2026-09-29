import type { DbOrTx } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditInput {
  actor: string;
  scope: string;
  targetId?: string | null;
  field?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  at: Date;
}

/** Who made a change, why and when: what every audited service call takes. */
export interface ChangeMeta {
  actor: string;
  reason: string;
  now: Date;
}

export type AuditChange = Omit<AuditInput, 'actor' | 'reason' | 'at'>;

/** Call inside the same transaction as the change it records. */
export async function auditChange(
  db: DbOrTx,
  meta: ChangeMeta,
  change: AuditChange,
): Promise<void> {
  await recordAudit(db, { ...change, actor: meta.actor, reason: meta.reason, at: meta.now });
}

/** Call inside the same transaction as the change it records. */
export async function recordAudit(db: DbOrTx, entry: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    at: entry.at,
    scope: entry.scope,
    targetId: entry.targetId ?? null,
    field: entry.field ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

/** One row per top-level key whose JSON differs. */
export async function recordAuditDiff(
  db: DbOrTx,
  base: Omit<AuditInput, 'field' | 'before' | 'after'>,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<number> {
  if (before === null || after === null) {
    await recordAudit(db, { ...base, before, after });
    return 1;
  }
  let count = 0;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    await recordAudit(db, {
      ...base,
      field: key,
      before: before[key] ?? null,
      after: after[key] ?? null,
    });
    count++;
  }
  return count;
}
