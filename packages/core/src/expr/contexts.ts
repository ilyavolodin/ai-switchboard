import type { Event } from '@ai-switchboard/sdk';

import type { BatchKind, BindingLimit, MappingMode, NotifyOn } from '../domain/status.js';

/** What each kind of expression reads; `context-descriptors.ts` describes the same shapes. */

/** `now` is a field here (the evaluation time as ISO-8601), as well as the `$now()` binding. */
export function filterContext(
  event: Event,
  process: Record<string, unknown> | null,
  now: Date,
): Record<string, unknown> {
  // Spreading the event lets the TDD's short form work: `attributes.label = 'x'`.
  return { ...event, event, process, now: now.toISOString() };
}

export interface RunContext {
  id: string;
  dryRun: boolean;
  mode: BatchKind;
  processId: string;
  processName: string;
  callbackUrl?: string;
  deadline?: string;
}

export function mappingContext(input: {
  events: Event[];
  process: Record<string, unknown>;
  run: RunContext;
  mode: MappingMode;
}): Record<string, unknown> {
  return { events: input.events, process: input.process, run: input.run, mode: input.mode };
}

/** The approval rule sees the mapping context plus the batch. */
export function approvalContext(
  mapping: Record<string, unknown>,
  batch: { id: string; kind: BatchKind; size: number },
): Record<string, unknown> {
  return { ...mapping, batch };
}

/** `run` is set for a run's outcome; `bindingLimit` only when throttled. */
export function templateContext(input: {
  process: Record<string, unknown>;
  events: readonly Event[];
  status: NotifyOn;
  batch: { id: string; kind: BatchKind };
  reason: string | null;
  run?: Record<string, unknown>;
  bindingLimit?: BindingLimit | null;
}): Record<string, unknown> {
  return {
    process: input.process,
    events: input.events,
    status: input.status,
    batch: input.batch,
    reason: input.reason,
    ...(input.run !== undefined ? { run: input.run } : {}),
    ...(input.bindingLimit !== undefined ? { bindingLimit: input.bindingLimit } : {}),
  };
}

/** `result` is set only in `after` steps. */
export function stepContext(input: {
  events: Event[];
  run: Record<string, unknown>;
  result?: unknown;
}): Record<string, unknown> {
  return {
    events: input.events,
    run: input.run,
    ...(input.result !== undefined ? { result: input.result } : {}),
  };
}
