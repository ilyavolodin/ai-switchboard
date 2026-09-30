import { validateAgainst } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import jsonata from 'jsonata';

import type { Clock } from '../clock.js';
import type { DbOrTx } from '../db/client.js';
import { destinations, notifiers, sources } from '../db/schema.js';
import { approvalMode, processDocumentSchema, type ProcessDocument } from '../domain/process.js';
import { effectiveTarget } from '../pipeline/target.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { errorText } from '../util/errors.js';
import { destinationSpecs } from './destination-specs.js';
import { badRequest, ServiceError } from './errors.js';
import { cronPreview } from './preview.js';

export interface ProcessValidationDeps {
  runtime: PluginRuntime;
  clock: Clock;
}

function compileError(expr: string | undefined): string | null {
  if (expr === undefined || expr.trim() === '') return null;
  try {
    jsonata(expr);
    return null;
  } catch (err) {
    return errorText(err);
  }
}

/**
 * Structural (JSON Schema) and semantic validation: referenced instances exist, event types are
 * declared by the source, the target matches the destination's targetSchema, expressions compile,
 * crons parse. `db` may be the transaction of a YAML apply, so instances it created count.
 */
export async function validateProcessDocument(
  deps: ProcessValidationDeps,
  db: DbOrTx,
  input: unknown,
): Promise<ProcessDocument> {
  const doc = structuredClone(input) as ProcessDocument;
  const check = validateAgainst(processDocumentSchema, doc);
  if (!check.valid) throw badRequest('The process document is invalid.', check.errors);
  const { runtime } = deps;
  const problems: string[] = [];

  const srcRows = await db
    .select({ id: sources.id, typeId: sources.typeId, name: sources.name })
    .from(sources);
  const triggerIds = new Set<string>();
  for (const [i, t] of doc.triggers.entries()) {
    if (triggerIds.has(t.id)) problems.push(`triggers[${i}].id "${t.id}" is used twice`);
    triggerIds.add(t.id);
    const src = srcRows.find((s) => s.id === t.sourceId);
    if (!src) {
      problems.push(`triggers[${i}] references a source that does not exist`);
      continue;
    }
    const live = runtime.source(src.id);
    const srcType = runtime.sourceType(src.typeId)?.type;
    // A dynamic source (webhook) declares its types per instance; without a live object, skip the check.
    const declaredList =
      live?.eventTypes ?? (srcType?.dynamicEventTypes ? [] : (srcType?.eventTypes ?? []));
    const declared = new Set(declaredList.map((e) => e.type));
    if (declared.size > 0) {
      for (const et of t.eventTypes) {
        if (!declared.has(et))
          problems.push(`triggers[${i}]: ${src.name} does not declare event type ${et}`);
      }
    }
    const err = compileError(t.filter);
    if (err) problems.push(`triggers[${i}].filter: ${err}`);
  }

  const scheduleIds = new Set<string>();
  for (const [i, s] of doc.schedules.entries()) {
    if (scheduleIds.has(s.id)) problems.push(`schedules[${i}].id "${s.id}" is used twice`);
    scheduleIds.add(s.id);
    const preview = cronPreview({ cron: s.cron, timezone: s.timezone }, deps.clock);
    if (!preview.valid) problems.push(`schedules[${i}]: ${preview.error ?? 'invalid cron'}`);
  }

  const [ex] = await db
    .select()
    .from(destinations)
    .where(eq(destinations.id, doc.destination.instanceId));
  if (!ex) {
    problems.push('destination.instanceId references a destination that does not exist');
  } else {
    const type = runtime.destinationType(ex.typeId)?.type;
    if (type) {
      const t = validateAgainst(
        type.targetSchema,
        effectiveTarget(doc.destination.target, ex.targetDefaults),
      );
      if (!t.valid)
        problems.push(
          ...t.errors.map(
            (e) => `destination.target${e.startsWith('(root)') ? e.slice(6) : ` ${e}`}`,
          ),
        );
    }
    // A destination created in the same apply has no live object yet: the type answers for it.
    const specs = destinationSpecs(runtime, ex);
    const budgetable = new Set(specs.usage.filter((d) => d.budgetable).map((d) => d.id));
    for (const dim of Object.keys(doc.budgets.usagePerDay ?? {})) {
      if (!budgetable.has(dim))
        problems.push(`budgets.usagePerDay.${dim}: not a budgetable usage dimension of ${ex.name}`);
    }
    const meters = new Set(specs.meters.map((m) => m.id));
    for (const m of Object.keys(doc.budgets.meterCeilings)) {
      if (!meters.has(m))
        problems.push(`budgets.meterCeilings.${m}: ${ex.name} has no meter "${m}"`);
    }
  }

  for (const [label, expr] of [
    ['input', doc.input],
    ['batching.groupBy', doc.batching.groupBy],
    [
      'gates.approval',
      approvalMode(doc.gates.approval) === 'expression' ? doc.gates.approval : undefined,
    ],
  ] as const) {
    const err = compileError(expr);
    if (err) problems.push(`${label}: ${err}`);
  }

  const exRows = await db.select({ id: destinations.id }).from(destinations);
  const providers = new Set([...srcRows.map((s) => s.id), ...exRows.map((e) => e.id)]);
  for (const phase of ['before', 'after'] as const) {
    for (const [i, s] of doc[phase].entries()) {
      if (!providers.has(s.provider)) problems.push(`${phase}[${i}].provider does not exist`);
      for (const [k, e] of [
        ['args', s.args],
        ['when', s.when],
      ] as const) {
        const err = compileError(e);
        if (err) problems.push(`${phase}[${i}].${k}: ${err}`);
      }
    }
  }
  const nRows = await db.select({ id: notifiers.id }).from(notifiers);
  for (const [i, n] of doc.notify.entries()) {
    if (!nRows.some((r) => r.id === n.notifierId))
      problems.push(`notify[${i}].notifierId does not exist`);
    const err = compileError(n.template);
    if (err) problems.push(`notify[${i}].template: ${err}`);
  }

  if (problems.length > 0)
    throw new ServiceError(
      422,
      'invalid_process',
      'The process cannot be saved as it is.',
      problems,
    );
  return doc;
}
