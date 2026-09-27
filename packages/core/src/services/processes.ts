import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { processes, processVersions } from '../db/schema.js';
import type { ProcessDocument } from '../domain/process.js';
import { recordAudit, recordAuditDiff } from './audit.js';

type ProcessRow = typeof processes.$inferSelect;

/** Who saves, why and when. */
export interface SaveMeta {
  actor: string;
  reason: string;
  now: Date;
}

/** What one save changes: the new document and how the audit log records it. */
export interface ProcessEdit {
  document: ProcessDocument;
  /** The version history's reason; defaults to the request's reason. */
  versionReason?: string;
  /** `diff`: one audit row per changed field. Otherwise one row with this field. */
  audit: 'diff' | { field: string; before?: unknown; after?: unknown };
}

/** One level of dotted keys so the audit log reads `gates.approval: none → always`. */
export function flattenForAudit(doc: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Create a process at version 1, with its first history row and audit, in one transaction. */
export async function createProcess(db: Db, doc: ProcessDocument, meta: SaveMeta): Promise<string> {
  const { actor, reason, now } = meta;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(processes)
      .values({
        name: doc.name,
        document: doc,
        enabled: doc.enabled,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: processes.id });
    if (!row) throw new Error('process insert returned no row');
    await tx.insert(processVersions).values({
      processId: row.id,
      version: 1,
      document: doc,
      savedBy: actor,
      savedAt: now,
      reason,
    });
    await recordAudit(tx, {
      actor,
      scope: 'process',
      targetId: row.id,
      field: 'created',
      after: doc,
      reason,
      at: now,
    });
    return row.id;
  });
}

/**
 * Save the next version of a process in one transaction. The row is locked while `edit` derives
 * the new document from it, so concurrent saves serialise; `edit` may throw to refuse (the
 * transaction rolls back). Returns false when there is no such process.
 */
export async function saveProcessVersion(
  db: Db,
  id: string,
  meta: SaveMeta,
  edit: (before: ProcessRow) => ProcessEdit,
): Promise<boolean> {
  const { actor, reason, now } = meta;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(processes).where(eq(processes.id, id)).for('update');
    if (!before) return false;
    const change = edit(before);
    const doc = change.document;
    const version = before.version + 1;
    await tx
      .update(processes)
      .set({ name: doc.name, document: doc, enabled: doc.enabled, version, updatedAt: now })
      .where(eq(processes.id, before.id));
    await tx.insert(processVersions).values({
      processId: before.id,
      version,
      document: doc,
      savedBy: actor,
      savedAt: now,
      reason: change.versionReason ?? reason,
    });
    const base = { actor, scope: 'process', targetId: before.id, reason, at: now };
    if (change.audit === 'diff') {
      await recordAuditDiff(tx, base, flattenForAudit(before.document), flattenForAudit(doc));
    } else {
      await recordAudit(tx, { ...base, ...change.audit });
    }
    return true;
  });
}

/** Delete a process and audit its last document. Returns false when there is no such process. */
export async function deleteProcess(db: Db, id: string, meta: SaveMeta): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(processes).where(eq(processes.id, id)).returning();
    if (!row) return false;
    await recordAudit(tx, {
      actor: meta.actor,
      scope: 'process',
      targetId: row.id,
      field: 'deleted',
      before: row.document,
      reason: meta.reason,
      at: meta.now,
    });
    return true;
  });
}
