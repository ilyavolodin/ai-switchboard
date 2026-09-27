import type { ArtifactRef } from '@ai-switchboard/sdk';
import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';

import {
  dispatches,
  events,
  executors,
  processes,
  runs,
  runUpdates,
  steps,
} from '../../db/schema.js';
import { runStatusLabel } from '../../domain/labels.js';
import type { RunStatusValue } from '../../domain/status.js';
import type { ApiContext } from '../context.js';
import type { Page, RunDetail, RunSummary, RunsQuery } from '../contract.js';
import { notFound } from '../errors.js';
import { decodeCursor, encodeCursor, pageLimit } from './paging.js';

type RunRow = typeof runs.$inferSelect;

/** Artifacts and event counts per batch, from the dispatches that joined it. */
export async function batchArtifacts(
  ctx: ApiContext,
  batchIds: string[],
): Promise<Map<string, { count: number; artifacts: ArtifactRef[] }>> {
  const out = new Map<string, { count: number; artifacts: ArtifactRef[] }>();
  if (batchIds.length === 0) return out;
  const rows = await ctx.db
    .select({ batchId: dispatches.batchId, artifact: events.artifact })
    .from(dispatches)
    .innerJoin(events, eq(events.id, dispatches.eventId))
    .where(and(inArray(dispatches.batchId, batchIds), eq(dispatches.outcome, 'batched')));
  for (const row of rows) {
    if (!row.batchId) continue;
    const entry = out.get(row.batchId) ?? { count: 0, artifacts: [] };
    entry.count++;
    if (!entry.artifacts.some((a) => a.kind === row.artifact.kind && a.id === row.artifact.id)) {
      entry.artifacts.push(row.artifact);
    }
    out.set(row.batchId, entry);
  }
  return out;
}

export async function runSummaries(ctx: ApiContext, rows: RunRow[]): Promise<RunSummary[]> {
  if (rows.length === 0) return [];
  const procIds = [...new Set(rows.map((r) => r.processId))];
  const exIds = [...new Set(rows.map((r) => r.executorId))];
  const [procs, exs, arts] = await Promise.all([
    ctx.db
      .select({ id: processes.id, name: processes.name })
      .from(processes)
      .where(inArray(processes.id, procIds)),
    ctx.db
      .select({ id: executors.id, name: executors.name })
      .from(executors)
      .where(inArray(executors.id, exIds)),
    batchArtifacts(
      ctx,
      rows.map((r) => r.batchId),
    ),
  ]);
  return rows.map((r) => {
    const a = arts.get(r.batchId);
    return {
      id: r.id,
      processId: r.processId,
      processName: procs.find((p) => p.id === r.processId)?.name ?? '(deleted process)',
      executorId: r.executorId,
      executorName: exs.find((e) => e.id === r.executorId)?.name ?? '(deleted executor)',
      kind: r.kind,
      status: r.status,
      statusLabel: runStatusLabel(r.status),
      statusReason: r.statusReason,
      externalId: r.externalId,
      externalUrl: r.externalUrl,
      usage: r.usage,
      bindingLimit: r.bindingLimit,
      dryRun: r.dryRun,
      invokedAt: r.invokedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationSeconds:
        r.invokedAt && r.finishedAt
          ? Math.round((r.finishedAt.getTime() - r.invokedAt.getTime()) / 100) / 10
          : null,
      eventCount: a?.count ?? 0,
      artifacts: a?.artifacts ?? [],
    };
  });
}

export async function listRuns(ctx: ApiContext, q: RunsQuery): Promise<Page<RunSummary>> {
  const limit = pageLimit(q.limit);
  const cursor = decodeCursor(q.cursor);
  const where: SQL[] = [];
  if (q.process) where.push(eq(runs.processId, q.process));
  if (q.executor) where.push(eq(runs.executorId, q.executor));
  if (q.status) where.push(inArray(runs.status, q.status.split(',') as RunStatusValue[]));
  if (cursor) where.push(lt(runs.createdAt, new Date(cursor.t)));
  const rows = await ctx.db
    .select()
    .from(runs)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(limit + 1);
  const items = await runSummaries(ctx, rows.slice(0, limit));
  const last = rows[limit - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.createdAt.toISOString() }) : null,
  };
}

export async function runDetail(ctx: ApiContext, id: string): Promise<RunDetail> {
  const [row] = await ctx.db.select().from(runs).where(eq(runs.id, id));
  if (!row) throw notFound('Run');
  const [summary] = await runSummaries(ctx, [row]);
  if (!summary) throw notFound('Run');
  const [stepRows, updates] = await Promise.all([
    ctx.db.select().from(steps).where(eq(steps.runId, id)).orderBy(steps.phase, steps.index),
    ctx.db.select().from(runUpdates).where(eq(runUpdates.runId, id)).orderBy(runUpdates.at),
  ]);
  return {
    ...summary,
    batchId: row.batchId,
    input: row.input,
    result: row.result,
    errors: row.errors ?? [],
    steps: stepRows.map((s) => ({
      phase: s.phase,
      index: s.index,
      providerId: s.providerId,
      action: s.action,
      args: s.args,
      status: s.status,
      error: s.error,
      at: s.at.toISOString(),
    })),
    updates: updates.map((u) => ({
      at: u.at.toISOString(),
      source: u.source,
      status: u.status,
      detail: u.detail,
    })),
  };
}
