import { CronExpressionParser } from 'cron-parser';
import { and, count, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';

import {
  approvals,
  batches,
  dispatches,
  destinations,
  processes,
  processVersions,
  runs,
  sources,
} from '../../db/schema.js';
import { processStatus } from '../../domain/labels.js';
import { countedRun } from '../../services/pipeline/counters.js';
import type { ProcessDocument } from '../../domain/process.js';
import type { StatusTone } from '../../domain/status.js';
import type { ApiContext } from '../context.js';
import type {
  PipelineDots,
  ProcessDetail,
  ProcessSummary,
  ProcessVersionDetail,
  ProcessVersionSummary,
  RecentBatchDTO,
} from '../contract.js';
import { notFound } from '../errors.js';
import { pageLimit } from './paging.js';
import { batchArtifacts, runSummaries } from './runs.js';

type ProcessRow = typeof processes.$inferSelect;

/** The next sweep across a process's enabled schedules, or null. */
export function nextSweepAt(document: ProcessDocument, now: Date): Date | null {
  let best: Date | null = null;
  for (const s of document.schedules) {
    if (!s.enabled) continue;
    try {
      const next = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: now })
        .next()
        .toDate();
      if (!best || next < best) best = next;
    } catch {
      // An invalid cron never fires; the editor reports it.
    }
  }
  return best;
}

interface HourCounts {
  matched: number;
  batched: number;
  passed: number;
  stopped: number;
  invoked: number;
  ok: number;
  bad: number;
}

function tone(n: number, problem = false): StatusTone {
  if (problem) return 'warn';
  return n > 0 ? 'ok' : 'off';
}

export function dotsFrom(c: HourCounts): PipelineDots {
  return {
    matched: c.matched,
    batched: c.batched,
    gated: c.passed,
    invoked: c.invoked,
    ok: c.ok,
    tones: [
      tone(c.matched),
      tone(c.batched),
      c.stopped > 0 ? 'warn' : tone(c.passed),
      tone(c.invoked),
      c.bad > 0 ? 'error' : tone(c.ok),
    ],
  };
}

/** Last-hour pipeline counts per process. */
async function hourCounts(ctx: ApiContext, ids: string[]): Promise<Map<string, HourCounts>> {
  const since = new Date(ctx.clock.now().getTime() - 3_600_000);
  const out = new Map<string, HourCounts>(
    ids.map((id) => [
      id,
      { matched: 0, batched: 0, passed: 0, stopped: 0, invoked: 0, ok: 0, bad: 0 },
    ]),
  );
  if (ids.length === 0) return out;
  const [d, b, r] = await Promise.all([
    ctx.db
      .select({ processId: dispatches.processId, outcome: dispatches.outcome, n: count() })
      .from(dispatches)
      .where(and(inArray(dispatches.processId, ids), gte(dispatches.createdAt, since)))
      .groupBy(dispatches.processId, dispatches.outcome),
    ctx.db
      .select({ processId: batches.processId, outcome: batches.outcome, n: count() })
      .from(batches)
      .where(and(inArray(batches.processId, ids), gte(batches.openedAt, since)))
      .groupBy(batches.processId, batches.outcome),
    ctx.db
      .select({ processId: runs.processId, status: runs.status, n: count() })
      .from(runs)
      .where(and(inArray(runs.processId, ids), gte(runs.createdAt, since)))
      .groupBy(runs.processId, runs.status),
  ]);
  for (const row of d) {
    const c = out.get(row.processId);
    if (!c) continue;
    c.matched += row.n;
    if (row.outcome === 'batched') c.batched += row.n;
  }
  for (const row of b) {
    const c = out.get(row.processId);
    if (!c) continue;
    if (row.outcome === 'invoked' || row.outcome === 'merged') c.passed += row.n;
    if (
      row.outcome === 'held' ||
      row.outcome === 'throttled' ||
      row.outcome === 'awaiting_approval'
    )
      c.stopped += row.n;
  }
  for (const row of r) {
    const c = out.get(row.processId);
    if (!c) continue;
    c.invoked += row.n;
    if (row.status === 'ok') c.ok += row.n;
    if (row.status === 'error' || row.status === 'failed' || row.status === 'unknown')
      c.bad += row.n;
  }
  return out;
}

export async function processSummaries(
  ctx: ApiContext,
  rows?: ProcessRow[],
): Promise<ProcessSummary[]> {
  const list = rows ?? (await ctx.db.select().from(processes).orderBy(processes.name));
  if (list.length === 0) return [];
  const ids = list.map((p) => p.id);
  const now = ctx.clock.now();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [hours, daily, pending, lastRuns, srcs, exs, day24] = await Promise.all([
    hourCounts(ctx, ids),
    ctx.db
      .select({
        processId: runs.processId,
        day: sql<string>`to_char(date_trunc('day', ${runs.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        n: count(),
      })
      .from(runs)
      .where(
        and(inArray(runs.processId, ids), gte(runs.createdAt, weekAgo), eq(runs.dryRun, false)),
      )
      .groupBy(runs.processId, sql`2`),
    ctx.db
      .select({ processId: approvals.processId, n: count() })
      .from(approvals)
      .where(and(inArray(approvals.processId, ids), isNull(approvals.decision)))
      .groupBy(approvals.processId),
    ctx.db
      .selectDistinctOn([runs.processId], {
        processId: runs.processId,
        status: runs.status,
        at: runs.createdAt,
      })
      .from(runs)
      .where(inArray(runs.processId, ids))
      .orderBy(runs.processId, desc(runs.createdAt)),
    ctx.db.select({ id: sources.id, name: sources.name }).from(sources),
    ctx.db.select({ id: destinations.id, name: destinations.name }).from(destinations),
    // The daily-cap bar counts exactly what the budget stage counts (by reservation time).
    ctx.db
      .select({ processId: runs.processId, n: count() })
      .from(runs)
      .where(and(inArray(runs.processId, ids), gt(runs.invokedAt, dayAgo), countedRun()))
      .groupBy(runs.processId),
  ]);

  return list.map((p) => {
    const doc = p.document;
    const last = lastRuns.find((r) => r.processId === p.id);
    const awaiting = pending.find((x) => x.processId === p.id)?.n ?? 0;
    const sparkline: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      sparkline.push(daily.find((d) => d.processId === p.id && d.day === day)?.n ?? 0);
    }
    const ex = exs.find((e) => e.id === doc.destination.instanceId);
    const next = nextSweepAt(doc, now);
    return {
      id: p.id,
      name: p.name,
      description: doc.description,
      enabled: p.enabled,
      status: processStatus({
        enabled: p.enabled,
        breakerOpen: p.breakerState === 'open',
        awaitingApproval: awaiting,
        lastRunStatus: last?.status ?? null,
      }),
      breakerState: p.breakerState,
      awaitingApproval: awaiting,
      dots: dotsFrom(
        hours.get(p.id) ?? {
          matched: 0,
          batched: 0,
          passed: 0,
          stopped: 0,
          invoked: 0,
          ok: 0,
          bad: 0,
        },
      ),
      sparkline,
      nextSweepAt: next?.toISOString() ?? null,
      dailyCap: {
        used: day24.find((d) => d.processId === p.id)?.n ?? 0,
        limit: doc.budgets.runsPerDay ?? null,
      },
      lastRunAt: last?.at.toISOString() ?? null,
      destination: ex ? { id: ex.id, name: ex.name } : null,
      triggers: doc.triggers.map((t) => ({
        sourceId: t.sourceId,
        sourceName: srcs.find((s) => s.id === t.sourceId)?.name ?? '(missing source)',
        describe: t.describe,
        eventTypes: t.eventTypes,
      })),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
}

export async function processDetail(ctx: ApiContext, id: string): Promise<ProcessDetail> {
  const [row] = await ctx.db.select().from(processes).where(eq(processes.id, id));
  if (!row) throw notFound('Process');
  const [summary] = await processSummaries(ctx, [row]);
  if (!summary) throw notFound('Process');
  const failures =
    row.breakerState === 'open'
      ? await ctx.db
          .select()
          .from(runs)
          .where(and(eq(runs.processId, id), inArray(runs.status, ['error', 'unknown', 'failed'])))
          .orderBy(desc(runs.createdAt))
          .limit(5)
      : [];
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    enabled: row.enabled,
    status: summary.status,
    breakerState: row.breakerState,
    breakerOpenedAt: row.breakerOpenedAt?.toISOString() ?? null,
    recentFailures: await runSummaries(ctx, failures),
    version: row.version,
    nextSweepAt: summary.nextSweepAt,
    awaitingApproval: summary.awaitingApproval,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Whether a process row exists. */
export async function processExists(ctx: ApiContext, id: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: processes.id })
    .from(processes)
    .where(eq(processes.id, id));
  return rows.length > 0;
}

/** A process's saved versions, newest first. */
export async function processVersionList(
  ctx: ApiContext,
  processId: string,
): Promise<ProcessVersionSummary[]> {
  const rows = await ctx.db
    .select({
      version: processVersions.version,
      savedBy: processVersions.savedBy,
      savedAt: processVersions.savedAt,
      reason: processVersions.reason,
    })
    .from(processVersions)
    .where(eq(processVersions.processId, processId))
    .orderBy(desc(processVersions.version));
  return rows.map((r) => ({ ...r, savedAt: r.savedAt.toISOString() }));
}

/** One saved version with its document. `version` comes from the path: anything else is a 404. */
export async function processVersion(
  ctx: ApiContext,
  processId: string,
  version: string | number,
): Promise<ProcessVersionDetail> {
  const n = Number(version);
  if (!Number.isSafeInteger(n) || n < 1) throw notFound('Version');
  const [row] = await ctx.db
    .select()
    .from(processVersions)
    .where(and(eq(processVersions.processId, processId), eq(processVersions.version, n)));
  if (!row) throw notFound('Version');
  return {
    version: row.version,
    savedBy: row.savedBy,
    savedAt: row.savedAt.toISOString(),
    reason: row.reason,
    document: row.document,
  };
}

/** A process's latest batches (events, sweeps and manual runs) with their artifacts. */
export async function recentBatches(
  ctx: ApiContext,
  processId: string,
  limit: string | undefined,
): Promise<RecentBatchDTO[]> {
  const rows = await ctx.db
    .select()
    .from(batches)
    .where(
      and(eq(batches.processId, processId), inArray(batches.kind, ['event', 'sweep', 'manual'])),
    )
    .orderBy(desc(batches.openedAt))
    .limit(pageLimit(limit, 20, 100));
  const arts = await batchArtifacts(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((b) => ({
    id: b.id,
    kind: b.kind,
    openedAt: b.openedAt.toISOString(),
    size: b.size,
    outcome: b.outcome,
    artifacts: arts.get(b.id)?.artifacts ?? [],
  }));
}
