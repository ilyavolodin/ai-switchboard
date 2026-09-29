import type { ArtifactRef } from '@ai-switchboard/sdk';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

import {
  batches,
  dispatches,
  events,
  destinations,
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
import { keysetPage } from './paging.js';

type RunRow = typeof runs.$inferSelect;

export async function batchArtifacts(
  ctx: ApiContext,
  batchIds: string[],
): Promise<Map<string, { count: number; artifacts: ArtifactRef[] }>> {
  const out = new Map<string, { count: number; artifacts: ArtifactRef[] }>();
  if (batchIds.length === 0) return out;
  // Like the pipeline's `batchEvents`: a sweep carries the event batches it merged, and a manual
  // test run the batch whose events it replays.
  const owners = new Map<string, Set<string>>();
  const own = (member: string, root: string) => {
    const set = owners.get(member) ?? new Set<string>();
    set.add(root);
    owners.set(member, set);
  };
  for (const id of batchIds) own(id, id);
  const roots = await ctx.db
    .select({ id: batches.id, eventsFrom: batches.eventsFrom })
    .from(batches)
    .where(inArray(batches.id, batchIds));
  for (const r of roots) if (r.eventsFrom !== null) own(r.eventsFrom, r.id);
  const sources = [...owners.keys()];
  const merged = await ctx.db
    .select({ id: batches.id, mergedInto: batches.mergedInto })
    .from(batches)
    .where(inArray(batches.mergedInto, sources));
  for (const m of merged) {
    if (m.mergedInto === null) continue;
    for (const root of owners.get(m.mergedInto) ?? []) own(m.id, root);
  }
  const rows = await ctx.db
    .select({ batchId: dispatches.batchId, eventId: events.id, artifact: events.artifact })
    .from(dispatches)
    .innerJoin(events, eq(events.id, dispatches.eventId))
    .where(and(inArray(dispatches.batchId, [...owners.keys()]), eq(dispatches.outcome, 'batched')));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.batchId) continue;
    for (const root of owners.get(row.batchId) ?? []) {
      if (seen.has(`${root}:${row.eventId}`)) continue;
      seen.add(`${root}:${row.eventId}`);
      const entry = out.get(root) ?? { count: 0, artifacts: [] };
      entry.count++;
      if (!entry.artifacts.some((a) => a.kind === row.artifact.kind && a.id === row.artifact.id)) {
        entry.artifacts.push(row.artifact);
      }
      out.set(root, entry);
    }
  }
  return out;
}

export async function runSummaries(ctx: ApiContext, rows: RunRow[]): Promise<RunSummary[]> {
  if (rows.length === 0) return [];
  const procIds = [...new Set(rows.map((r) => r.processId))];
  const exIds = [...new Set(rows.map((r) => r.destinationId))];
  const [procs, exs, arts] = await Promise.all([
    ctx.db
      .select({ id: processes.id, name: processes.name })
      .from(processes)
      .where(inArray(processes.id, procIds)),
    ctx.db
      .select({ id: destinations.id, name: destinations.name })
      .from(destinations)
      .where(inArray(destinations.id, exIds)),
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
      destinationId: r.destinationId,
      destinationName: exs.find((e) => e.id === r.destinationId)?.name ?? '(deleted destination)',
      kind: r.kind,
      status: r.status,
      statusLabel: runStatusLabel(r.status),
      statusReason: r.statusReason,
      externalId: r.externalId,
      externalUrl: r.externalUrl,
      usage: r.usage,
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
  const where: SQL[] = [];
  if (q.process) where.push(eq(runs.processId, q.process));
  if (q.destination) where.push(eq(runs.destinationId, q.destination));
  if (q.status) where.push(inArray(runs.status, q.status.split(',') as RunStatusValue[]));
  return keysetPage(
    q,
    { time: runs.createdAt, id: runs.id, keyOf: (r: RunRow) => ({ t: r.createdAt, id: r.id }) },
    where,
    (cond, take) =>
      ctx.db
        .select()
        .from(runs)
        .where(cond)
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(take),
    (rows) => runSummaries(ctx, rows),
  );
}

export async function runDetail(ctx: ApiContext, id: string): Promise<RunDetail> {
  const [row] = await ctx.db.select().from(runs).where(eq(runs.id, id));
  if (!row) throw notFound('Run');
  const [summary] = await runSummaries(ctx, [row]);
  if (!summary) throw notFound('Run');
  const [stepRows, updates, batchRows] = await Promise.all([
    ctx.db.select().from(steps).where(eq(steps.runId, id)).orderBy(steps.phase, steps.index),
    ctx.db.select().from(runUpdates).where(eq(runUpdates.runId, id)).orderBy(runUpdates.at),
    ctx.db
      .select({ requestedBy: batches.requestedBy })
      .from(batches)
      .where(eq(batches.id, row.batchId)),
  ]);
  return {
    ...summary,
    batchId: row.batchId,
    requestedBy: batchRows[0]?.requestedBy ?? null,
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
