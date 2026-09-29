import type { BatchKind } from '../domain/status.js';

export type MappingMode = Exclude<BatchKind, 'manual'>;

/** A manual run that replays a batch's events maps like an event run; with none, like a sweep. */
export function runMode(kind: BatchKind, eventCount: number): MappingMode {
  if (kind === 'manual') return eventCount > 0 ? 'event' : 'sweep';
  return kind;
}
