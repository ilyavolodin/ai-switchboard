import { validateAgainst } from '@ai-switchboard/sdk';

import type { Clock } from '../clock.js';
import type { DbOrTx } from '../db/client.js';
import { destinations, notifiers, sources } from '../db/schema.js';
import { processDocumentSchema, type ProcessDocument } from '../domain/process.js';
import { createExpressionEngine } from '../expr/index.js';
import { processProblems, type ValidationRefs } from '../pipeline/process-problems.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { cronPreview } from '../scheduler/preview.js';
import { destinationSpecs } from './destination-specs.js';
import { badRequest, unprocessable } from './errors.js';
import { findById } from './lookup.js';

export interface ProcessValidationDeps {
  runtime: PluginRuntime;
  clock: Clock;
}

/**
 * What the document references, as the runtime knows it now. `db` may be the transaction of a
 * YAML apply, so instances it created count; a destination created there has no live object yet,
 * and its type answers for it.
 */
export async function loadValidationRefs(
  runtime: PluginRuntime,
  db: DbOrTx,
  destinationId: string,
): Promise<ValidationRefs> {
  // Sequential: inside a transaction the queries share one connection.
  const srcRows = await db
    .select({ id: sources.id, typeId: sources.typeId, name: sources.name })
    .from(sources);
  const exRows = await db.select({ id: destinations.id }).from(destinations);
  const notifierRows = await db.select({ id: notifiers.id }).from(notifiers);
  const ex = await findById(db, destinations, destinationId);
  const specs = ex ? destinationSpecs(runtime, ex) : undefined;
  return {
    sources: srcRows.map((s) => {
      const type = runtime.sourceType(s.typeId)?.type;
      // A dynamic source (webhook) declares its types per instance; without a live object, skip.
      const declared =
        runtime.source(s.id)?.eventTypes ??
        (type?.dynamicEventTypes ? null : (type?.eventTypes ?? []));
      return { id: s.id, name: s.name, eventTypes: declared?.map((e) => e.type) ?? null };
    }),
    destination:
      ex && specs
        ? {
            name: ex.name,
            targetDefaults: ex.targetDefaults,
            targetSchema: runtime.destinationType(ex.typeId)?.type.targetSchema,
            budgetableUsage: new Set(specs.usage.filter((d) => d.budgetable).map((d) => d.id)),
            meters: new Set(specs.meters.map((m) => m.id)),
          }
        : undefined,
    providers: new Set([...srcRows.map((s) => s.id), ...exRows.map((e) => e.id)]),
    notifiers: new Set(notifierRows.map((n) => n.id)),
  };
}

/** Structural (JSON Schema), then semantic validation (`processProblems`). */
export async function validateProcessDocument(
  deps: ProcessValidationDeps,
  db: DbOrTx,
  input: unknown,
): Promise<ProcessDocument> {
  const doc = structuredClone(input) as ProcessDocument;
  const check = validateAgainst(processDocumentSchema, doc);
  if (!check.valid) throw badRequest('The process document is invalid.', check.errors);
  const refs = await loadValidationRefs(deps.runtime, db, doc.destination.instanceId);
  const engine = createExpressionEngine();
  const now = deps.clock.now();
  const problems = processProblems(doc, refs, {
    expressionError: (expr) => {
      const out = engine.check(expr);
      return out.ok ? null : out.error;
    },
    cronError: (cron, timezone) => {
      const preview = cronPreview({ cron, timezone }, now);
      return preview.valid ? null : (preview.error ?? 'invalid cron');
    },
  });
  if (problems.length > 0) {
    throw unprocessable('The process cannot be saved as it is.', problems, 'invalid_process');
  }
  return doc;
}
