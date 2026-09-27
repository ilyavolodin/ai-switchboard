import { randomUUID } from 'node:crypto';

import { and, eq, max, sql } from 'drizzle-orm';

import { batches, processes, scheduleTicks, type GateDecisionRecord } from '../../db/schema.js';
import type { Schedule } from '../../domain/process.js';
import { dueSweep, type DueSweep } from '../../scheduler/due.js';

import { JOBS, withTx, type Ctx, type ProcessRow } from './context.js';

/**
 * `scheduler.tick` (every minute): for every enabled schedule of every enabled process, fire the
 * sweep it owes. The `schedule_ticks` primary key makes each tick fire once across replicas. A
 * sweep skips matching and enters the pipeline at the gate; open event batches of the process
 * merge into it (one run).
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

/** Record the tick and create the sweep batch, merging open event batches. */
export async function createSweep(
  ctx: Ctx,
  proc: ProcessRow,
  schedule: Schedule,
  due: DueSweep,
): Promise<string | null> {
  const now = ctx.clock.now();
  const at = now.toISOString();
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
    const record: GateDecisionRecord = {
      stage: 'batch',
      check: 'sweep',
      pass: true,
      detail: `${schedule.cron} ${schedule.timezone}${due.catchUp ? ' (catch-up for a missed tick)' : ''}; tick ${due.tickAt.toISOString()}`,
      at,
    };
    await tx.insert(batches).values({
      id: batchId,
      processId: proc.id,
      batchKey: `sweep:${schedule.id}`,
      kind: 'sweep',
      openedAt: now,
      fireAfter: now,
      closedAt: now,
      size: open.reduce((n, b) => n + b.size, 0),
      outcome: 'closed',
      scheduleId: schedule.id,
      tickAt: due.tickAt,
      decisions: [record],
    });
    for (const b of open) {
      const merged: GateDecisionRecord = {
        stage: 'batch',
        check: 'merged',
        pass: true,
        detail: `merged into sweep ${batchId}`,
        at,
      };
      await tx
        .update(batches)
        .set({
          outcome: 'merged',
          mergedInto: batchId,
          closedAt: now,
          decisions: sql`${batches.decisions} || ${JSON.stringify([merged])}::jsonb`,
        })
        .where(eq(batches.id, b.id));
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
