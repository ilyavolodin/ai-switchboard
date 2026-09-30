import { desc, inArray, isNotNull, isNull } from 'drizzle-orm';

import type {
  ApprovalHistoryItem,
  ApprovalHistoryQuery,
  ApprovalItem,
  ApprovalRulesResponse,
  Page,
} from '../../contract/index.js';
import { approvals, batches, processes } from '../../db/schema.js';
import type { ReadDeps } from './deps.js';
import { namesById } from './names.js';
import { keysetPage } from './paging.js';
import { batchArtifacts } from './runs.js';

type ApprovalRow = typeof approvals.$inferSelect;

async function approvalItems(ctx: ReadDeps, rows: ApprovalRow[]): Promise<ApprovalItem[]> {
  if (rows.length === 0) return [];
  const batchIds = rows.map((r) => r.batchId);
  const [arts, names, kinds] = await Promise.all([
    batchArtifacts(ctx, batchIds),
    namesById(
      ctx.db,
      'process',
      rows.map((r) => r.processId),
    ),
    ctx.db
      .select({ id: batches.id, kind: batches.kind })
      .from(batches)
      .where(inArray(batches.id, batchIds)),
  ]);
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  return rows.map((r) => ({
    batchId: r.batchId,
    process: { id: r.processId, name: names.of(r.processId) },
    rule: r.rule,
    requestedAt: r.requestedAt.toISOString(),
    artifacts: arts.get(r.batchId)?.artifacts ?? [],
    eventCount: arts.get(r.batchId)?.count ?? 0,
    kind: kindOf.get(r.batchId) ?? 'event',
    input: r.input,
  }));
}

/** The approval queue, oldest request first. */
export async function pendingApprovals(ctx: ReadDeps): Promise<ApprovalItem[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(isNull(approvals.decision))
    .orderBy(approvals.requestedAt);
  return approvalItems(ctx, rows);
}

/** Decided approvals, newest decision first, paged by `(decidedAt, batchId)`. */
export async function approvalHistory(
  ctx: ReadDeps,
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
export async function approvalRules(ctx: ReadDeps): Promise<ApprovalRulesResponse> {
  const procs = await ctx.db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes);
  return {
    processes: procs
      .filter((p) => p.document.gates.approval !== 'none')
      .map((p) => ({ id: p.id, name: p.name, rule: p.document.gates.approval })),
  };
}
