import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type {
  CronPreviewRequest,
  CronPreviewResponse,
  FilterPreviewRequest,
  FilterPreviewResponse,
  InputPreviewRequest,
  InputPreviewResponse,
} from '../api/contract.js';
import type { Clock } from '../clock.js';
import { batches, events, executors } from '../db/schema.js';
import type { Deps } from '../deps.js';
import {
  createExpressionEngine,
  evaluateFilter,
  evaluateMapping,
  filterContext,
  mappingContext,
} from '../expr/index.js';
import { cronPreview as previewCron } from '../scheduler/preview.js';

import { evalFunctions, toEvent } from './pipeline/context.js';
import { isUuid } from './pipeline/errors.js';
import { batchEvents } from './pipeline/load.js';

/**
 * Live previews for the process editor. They evaluate with the same engine, contexts and limits
 * as the pipeline, against real stored events, and change nothing.
 */

/** The filter evaluated against the last `limit` (default 20) real events of those types. */
export async function filterPreview(
  deps: Deps,
  req: FilterPreviewRequest,
): Promise<FilterPreviewResponse> {
  if (!isUuid(req.sourceId) || req.eventTypes.length === 0) return { rows: [] };
  const limit = Math.min(Math.max(req.limit ?? 20, 1), 100);
  const rows = await deps.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.sourceId, req.sourceId),
        inArray(events.type, req.eventTypes),
        ne(events.stage, 'event_invalid'),
      ),
    )
    .orderBy(desc(events.receivedAt))
    .limit(limit);
  const engine = createExpressionEngine({ env: process.env });
  const now = deps.clock.now();
  const out: FilterPreviewResponse['rows'] = [];
  for (const row of rows) {
    const event = toEvent(row);
    const result = await evaluateFilter(
      engine,
      req.filter,
      filterContext(event, null, now),
      evalFunctions(deps, [event], now),
    );
    out.push({
      eventId: row.id,
      type: row.type,
      occurredAt: row.occurredAt.toISOString(),
      artifact: row.artifact,
      attributes: row.attributes,
      result: result.result,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }
  return { rows: out };
}

/** The input mapping evaluated over a recent batch (or an empty sweep) and validated. */
export async function inputPreview(
  deps: Deps,
  req: InputPreviewRequest,
): Promise<InputPreviewResponse> {
  const doc = req.document;
  const now = deps.clock.now();
  let evs: ReturnType<typeof toEvent>[] = [];
  let mode: 'event' | 'sweep' = req.mode ?? 'sweep';
  if (req.batchId !== undefined && isUuid(req.batchId)) {
    const [batch] = await deps.db.select().from(batches).where(eq(batches.id, req.batchId));
    if (batch) {
      evs = await batchEvents(deps.db, batch);
      if (req.mode === undefined) mode = batch.kind === 'event' ? 'event' : 'sweep';
    }
  }
  let schema = deps.runtime.executor(doc.executor.instanceId)?.type.inputSchema;
  if (schema === undefined && isUuid(doc.executor.instanceId)) {
    const [row] = await deps.db
      .select({ typeId: executors.typeId })
      .from(executors)
      .where(eq(executors.id, doc.executor.instanceId));
    if (row) schema = deps.runtime.executorType(row.typeId)?.type.inputSchema;
  }
  const engine = createExpressionEngine({ env: process.env });
  const out = await evaluateMapping(
    engine,
    doc.input,
    mappingContext({
      events: evs,
      process: {
        id: 'preview',
        name: doc.name,
        description: doc.description,
        enabled: doc.enabled,
      },
      run: {
        id: '00000000-0000-4000-8000-000000000000',
        dryRun: true,
        mode,
        processId: 'preview',
        processName: doc.name,
      },
      mode,
    }),
    evalFunctions(
      deps,
      evs,
      now,
      doc.triggers.map((t) => t.sourceId),
    ),
    schema,
  );
  const errors = out.ok ? [] : out.errors;
  if (schema === undefined) errors.push('executor instance not found: the input was not validated');
  return {
    input: out.ok ? out.input : (out.input ?? null),
    valid: out.ok && schema !== undefined,
    errors,
  };
}

/** Validate a cron, describe it and list the next three times from the core clock's now. */
export function cronPreview(req: CronPreviewRequest, clock: Clock): CronPreviewResponse {
  return previewCron(req, clock.now());
}
