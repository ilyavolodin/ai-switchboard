import { randomUUID } from 'node:crypto';

import { and, eq, inArray, max } from 'drizzle-orm';

import { batches, processes, scheduleTicks } from '../../db/schema.js';
import { appendDecisions, withTx } from '../../db/tx.js';
import type { Schedule } from '../../domain/process.js';
import { batchRecord } from '../../pipeline/decisions.js';
import { dueSweep, type DueSweep } from '../../scheduler/due.js';

import type { Ctx } from './context.js';
import { JOBS } from './jobs.js';
import { insertClosedBatch } from './tx.js';
import type { ProcessRow } from './views.js';

/**
 * The `schedule_ticks` primary key makes each tick fire once across replicas. Open event batches
 * of the process merge into the sweep, so they make one run.
 */
export async function schedulerTick(ctx: Ctx): Promise<string[]> {
  const now = ctx.clock.now();
  const procs = await ctx.db.select().from(processes).where(eq(processes.enabled, true));
  const fired: string[] = [];
  for (const proc of procs) {
    for (const schedule of proc.document.schedules) {
      if (!schedule.enabled) continue;
      const [last] = await ctx.db
        .select({ at: max(scheduleTicks.tickAt) })
        .from(scheduleTicks)
        .where(
          and(eq(scheduleTicks.processId, proc.id), eq(scheduleTicks.scheduleId, schedule.id)),
        );
      const due = dueSweep(schedule, { lastTickAt: last?.at ?? null, since: proc.updatedAt }, now);
      if (!due) continue;
      const batchId = await createSweep(ctx, proc, schedule, due);
      if (batchId) fired.push(batchId);
    }
  }
  return fired;
}

async function createSweep(
  ctx: Ctx,
  proc: ProcessRow,
  schedule: Schedule,
  due: DueSweep,
): Promise<string | null> {
  const now = ctx.clock.now();
  const out = await withTx(ctx.db, async (tx) => {
    const inserted = await tx
      .insert(scheduleTicks)
      .values({
        processId: proc.id,
        scheduleId: schedule.id,
        tickAt: due.tickAt,
        firedAt: now,
        catchUp: due.catchUp,
      })
      .onConflictDoNothing()
      .returning({ tickAt: scheduleTicks.tickAt });
    if (inserted.length === 0) return null;
    const batchId = randomUUID();
    const open = await tx
      .select({ id: batches.id, size: batches.size })
      .from(batches)
      .where(
        and(eq(batches.processId, proc.id), eq(batches.kind, 'event'), eq(batches.outcome, 'open')),
      )
      .for('update');
    const detail = `${schedule.cron} ${schedule.timezone}${due.catchUp ? ' (catch-up for a missed tick)' : ''}; tick ${due.tickAt.toISOString()}`;
    await insertClosedBatch(tx, now, {
      id: batchId,
      processId: proc.id,
      batchKey: `sweep:${schedule.id}`,
      kind: 'sweep',
      size: open.reduce((n, b) => n + b.size, 0),
      scheduleId: schedule.id,
      tickAt: due.tickAt,
      decisions: [batchRecord('sweep', now, detail)],
    });
    if (open.length > 0) {
      await tx
        .update(batches)
        .set({
          outcome: 'merged',
          mergedInto: batchId,
          closedAt: now,
          decisions: appendDecisions([batchRecord('merged', now, `merged into sweep ${batchId}`)]),
        })
        .where(
          inArray(
            batches.id,
            open.map((b) => b.id),
          ),
        );
    }
    await tx
      .update(scheduleTicks)
      .set({ batchId })
      .where(
        and(
          eq(scheduleTicks.processId, proc.id),
          eq(scheduleTicks.scheduleId, schedule.id),
          eq(scheduleTicks.tickAt, due.tickAt),
        ),
      );
    return { batchId, merged: open.map((b) => b.id) };
  });
  if (!out) return null;
  for (const id of out.merged) {
    ctx.telemetry.decision(
      'switchboard.batches',
      { process: proc.id, kind: 'event', outcome: 'merged', reason: 'sweep' },
      { process_id: proc.id, batch_id: id },
    );
  }
  await ctx.queue.send(JOBS.dispatch, { batchId: out.batchId });
  return out.batchId;
}
