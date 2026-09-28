import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  approvals,
  batches,
  processes,
  processVersions,
  type GateDecisionRecord,
} from '../db/schema.js';
import type { ProcessDocument } from '../domain/process.js';
import { recordAudit, recordAuditDiff } from './audit.js';
import { appendDecisions } from './pipeline/context.js';

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

/** What deleting a process cleaned up. */
export interface DeletedProcess {
  /** Batches that had not reached a run (open, closed, awaiting approval), now `rejected`. */
  droppedBatches: number;
  /** Pending approval requests, now `withdrawn`. */
  withdrawnApprovals: number;
}

/** Batch outcomes that still lead somewhere: a delete drops them. */
const UNFINISHED_BATCHES = ['open', 'closed', 'awaiting_approval'] as const;

/**
 * Delete a process and audit its last document, in one transaction with its cleanup: its
 * unfinished batches (open, closed but not dispatched, awaiting approval) end `rejected` with
 * reason `process_deleted`, and its pending approvals end `withdrawn` (one audit row each), so
 * the Approvals queue never shows a request nobody can act on. Runs, events, versions, schedule
 * ticks and decided batches stay for the trace and the audit log. A run already reserved goes
 * on to its terminal state. The dispatch stage re-checks `outcome = 'closed'` under a row lock,
 * so a batch dropped here never reaches the executor. Returns null when there is no such process.
 */
export async function deleteProcess(
  db: Db,
  id: string,
  meta: SaveMeta,
): Promise<DeletedProcess | null> {
  const { actor, reason, now } = meta;
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(processes).where(eq(processes.id, id)).returning();
    if (!row) return null;
    const record: GateDecisionRecord = {
      stage: 'batch',
      check: 'process_deleted',
      pass: false,
      detail: `${actor}: ${reason}`,
      at: now.toISOString(),
    };
    const dropped = await tx
      .update(batches)
      .set({
        outcome: 'rejected',
        outcomeReason: 'process_deleted',
        closedAt: sql`COALESCE(${batches.closedAt}, ${now.toISOString()}::timestamptz)`,
        approvalState: sql`CASE WHEN ${batches.approvalState} = 'pending' THEN 'rejected' ELSE ${batches.approvalState} END`,
        decisions: appendDecisions([record]),
      })
      .where(and(eq(batches.processId, id), inArray(batches.outcome, [...UNFINISHED_BATCHES])))
      .returning({ id: batches.id });
    const withdrawn = await tx
      .update(approvals)
      .set({ decision: 'withdrawn', decidedBy: actor, decidedAt: now, reason })
      .where(and(eq(approvals.processId, id), isNull(approvals.decision)))
      .returning({ batchId: approvals.batchId });
    for (const a of withdrawn) {
      await recordAudit(tx, {
        actor,
        scope: 'approval',
        targetId: a.batchId,
        field: 'decision',
        before: 'pending',
        after: 'withdrawn',
        reason: `process ${row.name} deleted: ${reason}`,
        at: now,
      });
    }
    await recordAudit(tx, {
      actor,
      scope: 'process',
      targetId: row.id,
      field: 'deleted',
      before: row.document,
      reason,
      at: now,
    });
    return { droppedBatches: dropped.length, withdrawnApprovals: withdrawn.length };
  });
}
