import { and, count, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm';

import type {
  ProcessDetail,
  ProcessSummary,
  ProcessVersionDetail,
  ProcessVersionSummary,
  RecentBatchDTO,
} from '../../contract/index.js';
import {
  approvals,
  batches,
  dispatches,
  processes,
  processVersions,
  runs,
} from '../../db/schema.js';
import { processStatus } from '../../domain/labels.js';
import { nextSweepAt } from '../../scheduler/due.js';
import { countedRun } from '../../services/pipeline/counters.js';
import { savedVersion } from '../../services/processes.js';
import { groupBy } from '../../util/collections.js';
import { DAY_MS, HOUR_MS, msAgo } from '../../util/time.js';
import { notFound } from '../errors.js';
import type { ReadDeps } from './deps.js';
import { namesById } from './names.js';
import { PROBLEM_RUN_STATUSES } from './outcomes.js';
import { pageLimit } from './paging.js';
import {
  dotsFrom,
  hourCountsByProcess,
  NO_HOUR_COUNTS,
  sparklineFrom,
  type HourCounts,
} from './processes.shape.js';
import { batchArtifacts, runSummaries } from './runs.js';
import { dayOf } from './stats.js';

type ProcessRow = typeof processes.$inferSelect;

async function hourCounts(deps: ReadDeps, ids: string[]): Promise<Map<string, HourCounts>> {
  const since = msAgo(deps.clock.now(), HOUR_MS);
  const [d, b, r] = await Promise.all([
    deps.db
      .select({ processId: dispatches.processId, outcome: dispatches.outcome, n: count() })
      .from(dispatches)
      .where(and(inArray(dispatches.processId, ids), gte(dispatches.createdAt, since)))
      .groupBy(dispatches.processId, dispatches.outcome),
    deps.db
      .select({ processId: batches.processId, outcome: batches.outcome, n: count() })
      .from(batches)
      .where(and(inArray(batches.processId, ids), gte(batches.openedAt, since)))
      .groupBy(batches.processId, batches.outcome),
    deps.db
      .select({ processId: runs.processId, status: runs.status, n: count() })
      .from(runs)
      .where(and(inArray(runs.processId, ids), gte(runs.createdAt, since)))
      .groupBy(runs.processId, runs.status),
  ]);
  return hourCountsByProcess(ids, d, b, r);
}

/** Pending approvals and the newest run, per process: what `processStatus` needs. */
async function processState(deps: ReadDeps, ids: string[]) {
  const [pending, lastRuns] = await Promise.all([
    deps.db
      .select({ processId: approvals.processId, n: count() })
      .from(approvals)
      .where(and(inArray(approvals.processId, ids), isNull(approvals.decision)))
      .groupBy(approvals.processId),
    deps.db
      .selectDistinctOn([runs.processId], {
        processId: runs.processId,
        status: runs.status,
        at: runs.createdAt,
      })
      .from(runs)
      .where(inArray(runs.processId, ids))
      .orderBy(runs.processId, desc(runs.createdAt)),
  ]);
  const awaiting = new Map(pending.map((p) => [p.processId, p.n]));
  const last = new Map(lastRuns.map((r) => [r.processId, r]));
  return (p: ProcessRow) => {
    const awaitingApproval = awaiting.get(p.id) ?? 0;
    const lastRun = last.get(p.id);
    return {
      awaitingApproval,
      lastRun,
      status: processStatus({
        enabled: p.enabled,
        breakerOpen: p.breakerState === 'open',
        awaitingApproval,
        lastRunStatus: lastRun?.status ?? null,
      }),
    };
  };
}

export async function processSummaries(
  deps: ReadDeps,
  rows?: ProcessRow[],
): Promise<ProcessSummary[]> {
  const list = rows ?? (await deps.db.select().from(processes).orderBy(processes.name));
  if (list.length === 0) return [];
  const ids = list.map((p) => p.id);
  const now = deps.clock.now();
  const [hours, daily, stateOf, sourceNames, destinationNames, day24] = await Promise.all([
    hourCounts(deps, ids),
    deps.db
      .select({ processId: runs.processId, day: dayOf(runs.createdAt), n: count() })
      .from(runs)
      .where(
        and(
          inArray(runs.processId, ids),
          gte(runs.createdAt, msAgo(now, 7 * DAY_MS)),
          eq(runs.dryRun, false),
        ),
      )
      .groupBy(runs.processId, dayOf(runs.createdAt)),
    processState(deps, ids),
    namesById(
      deps.db,
      'source',
      list.flatMap((p) => p.document.triggers.map((t) => t.sourceId)),
      '(missing source)',
    ),
    namesById(
      deps.db,
      'destination',
      list.map((p) => p.document.destination.instanceId),
    ),
    // The daily-cap bar counts exactly what the budget stage counts (by reservation time).
    deps.db
      .select({ processId: runs.processId, n: count() })
      .from(runs)
      .where(
        and(inArray(runs.processId, ids), gt(runs.invokedAt, msAgo(now, DAY_MS)), countedRun()),
      )
      .groupBy(runs.processId),
  ]);
  const used = new Map(day24.map((d) => [d.processId, d.n]));
  const dailyOf = groupBy(daily, (d) => d.processId);

  return list.map((p) => {
    const doc = p.document;
    const state = stateOf(p);
    const destinationName = destinationNames.get(doc.destination.instanceId);
    return {
      id: p.id,
      name: p.name,
      description: doc.description,
      enabled: p.enabled,
      status: state.status,
      breakerState: p.breakerState,
      awaitingApproval: state.awaitingApproval,
      dots: dotsFrom(hours.get(p.id) ?? NO_HOUR_COUNTS),
      sparkline: sparklineFrom(dailyOf.get(p.id) ?? [], now),
      nextSweepAt: nextSweepAt(doc, now)?.toISOString() ?? null,
      dailyCap: { used: used.get(p.id) ?? 0, limit: doc.budgets.runsPerDay ?? null },
      lastRunAt: state.lastRun?.at.toISOString() ?? null,
      destination:
        destinationName === undefined
          ? null
          : { id: doc.destination.instanceId, name: destinationName },
      triggers: doc.triggers.map((t) => ({
        sourceId: t.sourceId,
        sourceName: sourceNames.of(t.sourceId),
        describe: t.describe,
        eventTypes: t.eventTypes,
      })),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
}

export async function processDetail(deps: ReadDeps, id: string): Promise<ProcessDetail> {
  const [row] = await deps.db.select().from(processes).where(eq(processes.id, id));
  if (!row) throw notFound('Process');
  const [stateOf, failures] = await Promise.all([
    processState(deps, [row.id]),
    row.breakerState === 'open'
      ? deps.db
          .select()
          .from(runs)
          .where(and(eq(runs.processId, id), inArray(runs.status, PROBLEM_RUN_STATUSES)))
          .orderBy(desc(runs.createdAt))
          .limit(5)
      : Promise.resolve([]),
  ]);
  const state = stateOf(row);
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    enabled: row.enabled,
    status: state.status,
    breakerState: row.breakerState,
    breakerOpenedAt: row.breakerOpenedAt?.toISOString() ?? null,
    recentFailures: await runSummaries(deps, failures),
    version: row.version,
    nextSweepAt: nextSweepAt(row.document, deps.clock.now())?.toISOString() ?? null,
    awaitingApproval: state.awaitingApproval,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A process's saved versions, newest first. */
export async function processVersionList(
  deps: ReadDeps,
  processId: string,
): Promise<ProcessVersionSummary[]> {
  const rows = await deps.db
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

export async function processVersion(
  deps: ReadDeps,
  processId: string,
  version: string | number,
): Promise<ProcessVersionDetail> {
  const row = await savedVersion(deps.db, processId, version);
  return {
    version: row.version,
    savedBy: row.savedBy,
    savedAt: row.savedAt.toISOString(),
    reason: row.reason,
    document: row.document,
  };
}

export async function recentBatches(
  deps: ReadDeps,
  processId: string,
  limit: number | undefined,
): Promise<RecentBatchDTO[]> {
  const rows = await deps.db
    .select()
    .from(batches)
    .where(eq(batches.processId, processId))
    .orderBy(desc(batches.openedAt))
    .limit(pageLimit(limit, 20, 100));
  const arts = await batchArtifacts(
    deps,
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
