import type { RecentBatchDTO } from '@ai-switchboard/core/contract';

import { formatClock, toMs } from '../../lib/format.js';

/** The "example sweep context" choice: no batch, `mode = sweep`, empty events. */
export const EXAMPLE_SWEEP = '';

/** "batch 07:36 · LOL-1712", "sweep 07:00 · empty". */
export function batchLabel(b: RecentBatchDTO): string {
  const when = formatClock(toMs(b.openedAt) ?? 0);
  const ids = b.artifacts.map((a) => a.id);
  const what = ids.length > 0 ? ids.slice(0, 3).join(', ') + (ids.length > 3 ? '…' : '') : 'empty';
  return `${b.kind === 'event' ? 'batch' : b.kind} ${when} · ${what}`;
}

/** Options for a batch picker, recent batches first and the example sweep last. */
export function batchOptions(batches: RecentBatchDTO[]): { value: string; label: string }[] {
  return [
    ...batches.map((b) => ({ value: b.id, label: batchLabel(b) })),
    { value: EXAMPLE_SWEEP, label: 'example sweep · no events' },
  ];
}
