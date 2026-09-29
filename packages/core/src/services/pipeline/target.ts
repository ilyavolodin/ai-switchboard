import { eq } from 'drizzle-orm';

import { destinations, processes } from '../../db/schema.js';
import { effectiveTarget } from '../../pipeline/target.js';
import type { LiveDestination } from '../../plugins/runtime.js';

import type { Ctx } from './context.js';
import type { ProcessRow } from './views.js';

type DestinationRow = typeof destinations.$inferSelect;

export type RunTarget =
  | {
      ready: true;
      proc: ProcessRow;
      row: DestinationRow;
      live: LiveDestination;
      /** What invoke is sent, and what tracking, idempotency and timeouts are read from. */
      target: unknown;
    }
  | {
      ready: false;
      proc: ProcessRow | undefined;
      row: DestinationRow | undefined;
      live: LiveDestination | undefined;
    };

export async function runTarget(
  ctx: Pick<Ctx, 'db' | 'runtime'>,
  run: { processId: string; destinationId: string },
): Promise<RunTarget> {
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
  const [row] = await ctx.db
    .select()
    .from(destinations)
    .where(eq(destinations.id, run.destinationId));
  const live = ctx.runtime.destination(run.destinationId);
  if (!proc || !row || !live) return { ready: false, proc, row, live };
  return {
    ready: true,
    proc,
    row,
    live,
    target: effectiveTarget(proc.document.destination.target, row.targetDefaults),
  };
}
