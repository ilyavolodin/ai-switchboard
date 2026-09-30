import { and, eq } from 'drizzle-orm';

import type { RawRequest } from '@ai-switchboard/sdk';

import { destinations, runs } from '../../../db/schema.js';
import { isTerminalRunStatus } from '../../../domain/status.js';
import { checkRunStatus } from '../../../pipeline/plugin-results.js';
import { isUuid } from '../../../util/uuid.js';
import { findById } from '../../lookup.js';
import type { Ctx } from '../context.js';
import { sendSystemAlert } from '../notify.js';
import type { IngressOutcome } from '../outcomes.js';

import { applyTracking } from './tracking.js';

export async function handleCallback(
  ctx: Ctx,
  destinationId: string,
  req: RawRequest,
): Promise<IngressOutcome> {
  try {
    const row = await findById(ctx.db, destinations, destinationId);
    if (!row) return 'not_found';
    const live = ctx.runtime.destination(destinationId);
    // No live instance right now (plugin unavailable, secret error): let the backend retry.
    if (!live) return 'unavailable';
    if (!live.destination.verifyCallback) return 'not_found';
    let verified: { runId: string; status: unknown } | null = null;
    try {
      verified = live.destination.verifyCallback(req);
    } catch {
      // Counted against the plugin by the runtime's attribution wrapper; a rejection here.
      verified = null;
    }
    if (!verified) {
      ctx.log.warn(
        { destination_id: destinationId, remote_address: req.remoteAddress },
        'callback rejected by verifyCallback',
      );
      await sendSystemAlert(ctx, {
        key: `callback_verification:${destinationId}`,
        title: `Callback verification failed: ${row.name}`,
        text: `A callback to ${row.name} from ${req.remoteAddress ?? 'an unknown address'} failed verification and was rejected.`,
        severity: 'warning',
      });
      return 'rejected';
    }
    if (!isUuid(verified.runId)) return 'not_found';
    const [run] = await ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, verified.runId), eq(runs.destinationId, destinationId)));
    if (!run) return 'not_found';
    const checked = checkRunStatus(verified.status);
    if (!checked.ok) {
      ctx.runtime.recordPluginError(
        live.pluginName,
        'exception',
        `verifyCallback: ${checked.problem}`,
      );
      return 'malformed';
    }
    const status = checked.value;
    if (isTerminalRunStatus(run.status)) return 'accepted';
    // A child of the callback's HTTP span, linked to the trace that invoked the run.
    await ctx.telemetry.span(
      'switchboard.track',
      {
        run_id: run.id,
        process_id: run.processId,
        batch_id: run.batchId,
        'switchboard.track.via': 'callback',
        'switchboard.run.state': status.state,
      },
      () => applyTracking(ctx, run, status, 'callback'),
      { links: [run.traceContext] },
    );
    return 'accepted';
  } catch (err) {
    ctx.log.error({ err, destination_id: destinationId }, 'callback handling failed');
    return 'unavailable';
  }
}
