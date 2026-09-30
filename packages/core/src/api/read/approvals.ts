import { desc, inArray, isNotNull, isNull } from 'drizzle-orm';

import { approvals, batches, processes } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import type {
  ApprovalHistoryItem,
  ApprovalHistoryQuery,
  ApprovalItem,
  ApprovalRulesResponse,
  Page,
} from '../../contract/index.js';
import { keysetPage } from './paging.js';
import { batchArtifacts } from './runs.js';

type ApprovalRow = typeof approvals.$inferSelect;

async function approvalItems(ctx: ApiContext, rows: ApprovalRow[]): Promise<ApprovalItem[]> {
  if (rows.length === 0) return [];
  const batchIds = rows.map((r) => r.batchId);
  const processIds = [...new Set(rows.map((r) => r.processId))];
  const [arts, procs, kinds] = await Promise.all([
    batchArtifacts(ctx, batchIds),
    ctx.db
      .select({ id: processes.id, name: processes.name })
      .from(processes)
      .where(inArray(processes.id, processIds)),
    ctx.db
      .select({ id: batches.id, kind: batches.kind })
      .from(batches)
      .where(inArray(batches.id, batchIds)),
  ]);
  const names = new Map(procs.map((p) => [p.id, p.name]));
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  return rows.map((r) => ({
    batchId: r.batchId,
    process: { id: r.processId, name: names.get(r.processId) ?? '(deleted process)' },
    rule: r.rule,
    requestedAt: r.requestedAt.toISOString(),
    artifacts: arts.get(r.batchId)?.artifacts ?? [],
    eventCount: arts.get(r.batchId)?.count ?? 0,
    kind: kindOf.get(r.batchId) ?? 'event',
    input: r.input,
  }));
}

/** The approval queue, oldest request first. */
export async function pendingApprovals(ctx: ApiContext): Promise<ApprovalItem[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(isNull(approvals.decision))
    .orderBy(approvals.requestedAt);
  return approvalItems(ctx, rows);
}

/** Decided approvals, newest decision first, paged by `(decidedAt, batchId)`. */
export async function approvalHistory(
  ctx: ApiContext,
  q: ApprovalHistoryQuery,
): Promise<Page<ApprovalHistoryItem>> {
  return keysetPage(
    q,
    {
      time: approvals.decidedAt,
      id: approvals.batchId,
      keyOf: (r: ApprovalRow) => ({ t: r.decidedAt, id: r.batchId }),
    },
    [isNotNull(approvals.decision)],
    (cond, take) =>
      ctx.db
        .select()
        .from(approvals)
        .where(cond)
        .orderBy(desc(approvals.decidedAt), desc(approvals.batchId))
        .limit(take),
    async (rows) => {
      const items = await approvalItems(ctx, rows);
      return items.map((item, i) => {
        const r = rows[i];
        return {
          ...item,
          decision: r?.decision ?? 'rejected',
          decidedBy: r?.decidedBy ?? '',
          decidedAt: r?.decidedAt?.toISOString() ?? '',
          reason: r?.reason ?? '',
        };
      });
    },
  );
}

/** Processes whose approval gate is not `none`, with their rule. */
export async function approvalRules(ctx: ApiContext): Promise<ApprovalRulesResponse> {
  const procs = await ctx.db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes);
  return {
    processes: procs
      .filter((p) => p.document.gates.approval !== 'none')
      .map((p) => ({ id: p.id, name: p.name, rule: p.document.gates.approval })),
  };
}
