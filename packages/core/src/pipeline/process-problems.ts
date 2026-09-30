import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';

import { approvalMode, type ProcessDocument } from '../domain/process.js';

import { effectiveTarget } from './target.js';

export interface SourceRef {
  id: string;
  name: string;
  /** `null` when the declared types are not known (a dynamic type with no live instance). */
  eventTypes: readonly string[] | null;
}

export interface DestinationRef {
  name: string;
  targetDefaults: Record<string, unknown>;
  /** `undefined` without the plugin: the target is not checked. */
  targetSchema: JSONSchema | undefined;
  budgetableUsage: ReadonlySet<string>;
  meters: ReadonlySet<string>;
}

/** Everything a process document may reference, loaded once for the check. */
export interface ValidationRefs {
  sources: readonly SourceRef[];
  destination: DestinationRef | undefined;
  /** Ids of sources and destinations, which can run step actions. */
  providers: ReadonlySet<string>;
  notifiers: ReadonlySet<string>;
}

export interface ValidationChecks {
  /** The compile error of a non-blank expression, or `null`. */
  expressionError(expr: string): string | null;
  /** Why a schedule would not fire, or `null`. */
  cronError(cron: string, timezone: string): string | null;
}

/**
 * Semantic problems of a structurally valid document: referenced instances exist, event types are
 * declared by the source, the target matches the destination's schema, expressions compile,
 * crons parse, ids are unique. Empty when the process can be saved.
 */
export function processProblems(
  doc: ProcessDocument,
  refs: ValidationRefs,
  checks: ValidationChecks,
): string[] {
  const problems: string[] = [];
  const compile = (label: string, expr: string | undefined): void => {
    if (expr === undefined || expr.trim() === '') return;
    const err = checks.expressionError(expr);
    if (err !== null) problems.push(`${label}: ${err}`);
  };

  const triggerIds = new Set<string>();
  for (const [i, t] of doc.triggers.entries()) {
    if (triggerIds.has(t.id)) problems.push(`triggers[${i}].id "${t.id}" is used twice`);
    triggerIds.add(t.id);
    const src = refs.sources.find((s) => s.id === t.sourceId);
    if (!src) {
      problems.push(`triggers[${i}] references a source that does not exist`);
      continue;
    }
    const declared = new Set(src.eventTypes ?? []);
    if (declared.size > 0) {
      for (const et of t.eventTypes) {
        if (!declared.has(et))
          problems.push(`triggers[${i}]: ${src.name} does not declare event type ${et}`);
      }
    }
    compile(`triggers[${i}].filter`, t.filter);
  }

  const scheduleIds = new Set<string>();
  for (const [i, s] of doc.schedules.entries()) {
    if (scheduleIds.has(s.id)) problems.push(`schedules[${i}].id "${s.id}" is used twice`);
    scheduleIds.add(s.id);
    const err = checks.cronError(s.cron, s.timezone);
    if (err !== null) problems.push(`schedules[${i}]: ${err}`);
  }

  const ex = refs.destination;
  if (!ex) {
    problems.push('destination.instanceId references a destination that does not exist');
  } else {
    if (ex.targetSchema) {
      const t = validateAgainst(
        ex.targetSchema,
        effectiveTarget(doc.destination.target, ex.targetDefaults),
      );
      if (!t.valid)
        problems.push(
          ...t.errors.map(
            (e) => `destination.target${e.startsWith('(root)') ? e.slice(6) : ` ${e}`}`,
          ),
        );
    }
    for (const dim of Object.keys(doc.budgets.usagePerDay ?? {})) {
      if (!ex.budgetableUsage.has(dim))
        problems.push(`budgets.usagePerDay.${dim}: not a budgetable usage dimension of ${ex.name}`);
    }
    for (const m of Object.keys(doc.budgets.meterCeilings)) {
      if (!ex.meters.has(m))
        problems.push(`budgets.meterCeilings.${m}: ${ex.name} has no meter "${m}"`);
    }
  }

  compile('input', doc.input);
  compile('batching.groupBy', doc.batching.groupBy);
  if (approvalMode(doc.gates.approval) === 'expression') {
    compile('gates.approval', doc.gates.approval);
  }

  for (const phase of ['before', 'after'] as const) {
    for (const [i, s] of doc[phase].entries()) {
      if (!refs.providers.has(s.provider)) problems.push(`${phase}[${i}].provider does not exist`);
      compile(`${phase}[${i}].args`, s.args);
      compile(`${phase}[${i}].when`, s.when);
    }
  }
  for (const [i, n] of doc.notify.entries()) {
    if (!refs.notifiers.has(n.notifierId)) problems.push(`notify[${i}].notifierId does not exist`);
    compile(`notify[${i}].template`, n.template);
  }
  return problems;
}
