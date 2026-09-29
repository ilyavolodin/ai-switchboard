import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';

import type { DbOrTx, Tx } from '../../db/client.js';
import { processes, runs } from '../../db/schema.js';
import { TERMINAL_RUN_STATUSES, isSettledRunStatus } from '../../domain/status.js';
import { breakerHistoryLimit, breakerOpensAfterRun } from '../../pipeline/breaker.js';

import type { RunRow } from './views.js';

export interface BreakerOpened {
  processId: string;
  name: string;
  failures: number;
}

/** In the transaction that settles `run`; opens the process's breaker on a failure streak. */
export async function evaluateBreakerAfterClose(
  tx: Tx,
  run: Pick<RunRow, 'processId' | 'dryRun'>,
  status: string,
  now: Date,
): Promise<BreakerOpened | null> {
  if (run.dryRun || !isSettledRunStatus(status)) return null;
  const [proc] = await tx
    .select()
    .from(processes)
    .where(eq(processes.id, run.processId))
    .for('update');
  if (proc?.breakerState !== 'closed') return null;
  const threshold = proc.document.gates.breaker.threshold;
  const recent = await tx
    .select({ status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.processId, run.processId),
        eq(runs.dryRun, false),
        inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
        isNotNull(runs.finishedAt),
        proc.breakerResetAt ? gt(runs.finishedAt, proc.breakerResetAt) : sql`true`,
      ),
    )
    .orderBy(desc(runs.finishedAt), desc(runs.createdAt))
    .limit(breakerHistoryLimit(threshold));
  const next = breakerOpensAfterRun(
    recent.map((r) => r.status),
    threshold,
  );
  if (!next.opens) return null;
  await tx
    .update(processes)
    .set({ breakerState: 'open', breakerOpenedAt: now })
    .where(eq(processes.id, run.processId));
  return { processId: proc.id, name: proc.name, failures: next.failures };
}

/**
 * With `openedAt`, only that opening is closed: a breaker reset and re-opened meanwhile stays
 * open. Returns whether it closed.
 */
export async function closeBreaker(
  db: DbOrTx,
  processId: string,
  now: Date,
  openedAt?: Date,
): Promise<boolean> {
  const closed = await db
    .update(processes)
    .set({ breakerState: 'closed', breakerOpenedAt: null, breakerResetAt: now })
    .where(
      openedAt
        ? and(
            eq(processes.id, processId),
            eq(processes.breakerState, 'open'),
            eq(processes.breakerOpenedAt, openedAt),
          )
        : eq(processes.id, processId),
    )
    .returning({ id: processes.id });
  return closed.length > 0;
}
