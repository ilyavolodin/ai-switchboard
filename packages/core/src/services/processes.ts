import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '../db/client.js';
import { approvals, batches, processes, processVersions } from '../db/schema.js';
import { appendDecisions } from '../db/tx.js';
import type { ProcessDocument } from '../domain/process.js';
import { processDeletedRecord } from '../pipeline/decisions.js';
import { auditChange, recordAuditDiff, type ChangeMeta } from './audit.js';
import { conflict, notFound } from './errors.js';
import { validateProcessDocument, type ProcessValidationDeps } from './process-validation.js';

type ProcessRow = typeof processes.$inferSelect;

export interface ProcessEdit {
  document: ProcessDocument;
  /** Defaults to the request's reason. */
  versionReason?: string;
  /** `diff`: one audit row per changed field. Otherwise one row with this field. */
  audit: 'diff' | { field: string; before?: unknown; after?: unknown };
}

/** One level only, so the audit log reads `gates.approval: none → always`. */
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

/** Inside the caller's transaction (YAML apply uses it for every process it creates). */
export async function insertProcess(
  tx: DbOrTx,
  doc: ProcessDocument,
  meta: ChangeMeta,
): Promise<string> {
  const [row] = await tx
    .insert(processes)
    .values({
      name: doc.name,
      document: doc,
      enabled: doc.enabled,
      version: 1,
      createdAt: meta.now,
      updatedAt: meta.now,
    })
    .returning({ id: processes.id });
  if (!row) throw new Error('process insert returned no row');
  await tx.insert(processVersions).values({
    processId: row.id,
    version: 1,
    document: doc,
    savedBy: meta.actor,
    savedAt: meta.now,
    reason: meta.reason,
  });
  await auditChange(tx, meta, { scope: 'process', targetId: row.id, field: 'created', after: doc });
  return row.id;
}

/**
 * The row is locked while `edit` derives the new document, so concurrent saves serialise; `edit`
 * may throw to refuse (the transaction rolls back).
 */
export async function saveProcessVersion(
  db: Db,
  id: string,
  meta: ChangeMeta,
  edit: (before: ProcessRow) => ProcessEdit,
): Promise<boolean> {
  return db.transaction((tx) => saveProcessVersionIn(tx, id, meta, edit));
}

/** Inside the caller's transaction; the row is locked the same way. */
export async function saveProcessVersionIn(
  tx: DbOrTx,
  id: string,
  meta: ChangeMeta,
  edit: (before: ProcessRow) => ProcessEdit,
): Promise<boolean> {
  const [before] = await tx.select().from(processes).where(eq(processes.id, id)).for('update');
  if (!before) return false;
  const change = edit(before);
  const doc = change.document;
  const version = before.version + 1;
  await tx
    .update(processes)
    .set({ name: doc.name, document: doc, enabled: doc.enabled, version, updatedAt: meta.now })
    .where(eq(processes.id, before.id));
  await tx.insert(processVersions).values({
    processId: before.id,
    version,
    document: doc,
    savedBy: meta.actor,
    savedAt: meta.now,
    reason: change.versionReason ?? meta.reason,
  });
  if (change.audit === 'diff') {
    await recordAuditDiff(
      tx,
      {
        actor: meta.actor,
        scope: 'process',
        targetId: before.id,
        reason: meta.reason,
        at: meta.now,
      },
      flattenForAudit(before.document),
      flattenForAudit(doc),
    );
  } else {
    await auditChange(tx, meta, { scope: 'process', targetId: before.id, ...change.audit });
  }
  return true;
}

export interface DeletedProcess {
  droppedBatches: number;
  withdrawnApprovals: number;
}

const UNFINISHED_BATCHES = ['open', 'closed', 'awaiting_approval'] as const;

/**
 * Unfinished batches end `rejected` and pending approvals end `withdrawn`, so the Approvals queue
 * never shows a request nobody can act on. Runs, events, versions and decided batches stay for
 * the trace and the audit log; a run already reserved goes on to its terminal state. The dispatch
 * stage re-checks `outcome = 'closed'` under a row lock, so a batch dropped here never reaches the
 * destination.
 */
export async function deleteProcess(db: Db, id: string, meta: ChangeMeta): Promise<DeletedProcess> {
  const { actor, reason, now } = meta;
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(processes).where(eq(processes.id, id)).returning();
    if (!row) throw notFound('Process');
    const dropped = await tx
      .update(batches)
      .set({
        outcome: 'rejected',
        outcomeReason: 'process_deleted',
        closedAt: sql`COALESCE(${batches.closedAt}, ${now.toISOString()}::timestamptz)`,
        approvalState: sql`CASE WHEN ${batches.approvalState} = 'pending' THEN 'rejected' ELSE ${batches.approvalState} END`,
        decisions: appendDecisions([processDeletedRecord(`${actor}: ${reason}`, now)]),
      })
      .where(and(eq(batches.processId, id), inArray(batches.outcome, [...UNFINISHED_BATCHES])))
      .returning({ id: batches.id });
    const withdrawn = await tx
      .update(approvals)
      .set({ decision: 'withdrawn', decidedBy: actor, decidedAt: now, reason })
      .where(and(eq(approvals.processId, id), isNull(approvals.decision)))
      .returning({ batchId: approvals.batchId });
    for (const a of withdrawn) {
      await auditChange(
        tx,
        { ...meta, reason: `process ${row.name} deleted: ${reason}` },
        {
          scope: 'approval',
          targetId: a.batchId,
          field: 'decision',
          before: 'pending',
          after: 'withdrawn',
        },
      );
    }
    await auditChange(tx, meta, {
      scope: 'process',
      targetId: row.id,
      field: 'deleted',
      before: row.document,
    });
    return { droppedBatches: dropped.length, withdrawnApprovals: withdrawn.length };
  });
}

export interface ProcessDeps extends ProcessValidationDeps {
  db: Db;
}

/** Validates the document, then creates the process at version 1. */
export async function createProcessFrom(
  deps: ProcessDeps,
  document: unknown,
  meta: ChangeMeta,
): Promise<string> {
  const doc = await validateProcessDocument(deps, deps.db, document);
  return deps.db.transaction((tx) => insertProcess(tx, doc, meta));
}

/** Optimistic concurrency: a 409 when someone saved since `expectedVersion`. */
export async function updateProcess(
  deps: ProcessDeps,
  id: string,
  document: unknown,
  expectedVersion: number,
  meta: ChangeMeta,
): Promise<void> {
  const doc = await validateProcessDocument(deps, deps.db, document);
  const saved = await saveProcessVersion(deps.db, id, meta, (before) => {
    if (expectedVersion !== before.version) {
      throw conflict(
        `The process was changed by someone else (version ${before.version}); reload and reapply your edit.`,
      );
    }
    return { document: doc, audit: 'diff' };
  });
  if (!saved) throw notFound('Process');
}

export async function setProcessEnabled(
  db: Db,
  id: string,
  enabled: boolean,
  meta: ChangeMeta,
): Promise<void> {
  const saved = await saveProcessVersion(db, id, meta, (before) => ({
    document: { ...before.document, enabled },
    audit: { field: 'enabled', before: before.enabled, after: enabled },
  }));
  if (!saved) throw notFound('Process');
}

/** `version` comes from the path: anything but a positive integer is a 404, not a 500. */
export async function savedVersion(
  db: DbOrTx,
  processId: string,
  version: string | number,
): Promise<typeof processVersions.$inferSelect> {
  const n = Number(version);
  if (!Number.isSafeInteger(n) || n < 1) throw notFound('Version');
  const [row] = await db
    .select()
    .from(processVersions)
    .where(and(eq(processVersions.processId, processId), eq(processVersions.version, n)));
  if (!row) throw notFound('Version');
  return row;
}

/** Saves an old version's document as the newest version (checked like any save). */
export async function restoreProcessVersion(
  deps: ProcessDeps,
  id: string,
  version: string | number,
  meta: ChangeMeta,
): Promise<void> {
  const old = await savedVersion(deps.db, id, version);
  const doc = await validateProcessDocument(deps, deps.db, old.document);
  const saved = await saveProcessVersion(deps.db, id, meta, (before) => ({
    document: doc,
    versionReason: `restore v${old.version}: ${meta.reason}`,
    audit: { field: 'restored', before: before.version, after: old.version },
  }));
  if (!saved) throw notFound('Process');
}
