import type { ProcessDocument } from '../domain/process.js';
import { addSeconds, SECOND_MS } from '../util/time.js';

/**
 * Each join pushes `fireAfter` to `now + debounceSeconds`. A batch closes at `maxSize`, at
 * `maxAgeSeconds` since it opened (`0` means no age cap), or when the debounce elapses.
 */

export type BatchingConfig = Pick<
  ProcessDocument['batching'],
  'debounceSeconds' | 'maxSize' | 'maxAgeSeconds'
>;

export interface OpenBatchState {
  id: string;
  openedAt: Date;
  fireAfter: Date;
  size: number;
}

export type CloseReason = 'size' | 'age' | 'debounce';

export type JoinDecision =
  | { action: 'open'; openedAt: Date; fireAfter: Date; size: 1; closeNow: CloseReason | null }
  | {
      action: 'join';
      batchId: string;
      fireAfter: Date;
      size: number;
      closeNow: CloseReason | null;
    };

function ageLimit(openedAt: Date, config: BatchingConfig): number {
  return config.maxAgeSeconds > 0
    ? addSeconds(openedAt, config.maxAgeSeconds).getTime()
    : Number.POSITIVE_INFINITY;
}

function fireAfterFor(openedAt: Date, config: BatchingConfig, now: Date): Date {
  const debounced = addSeconds(now, Math.max(0, config.debounceSeconds)).getTime();
  return new Date(Math.min(debounced, ageLimit(openedAt, config)));
}

function closeReason(
  size: number,
  openedAt: Date,
  fireAfter: Date,
  config: BatchingConfig,
  now: Date,
): CloseReason | null {
  if (size >= Math.max(1, config.maxSize)) return 'size';
  if (now.getTime() >= ageLimit(openedAt, config)) return 'age';
  if (now.getTime() >= fireAfter.getTime()) return 'debounce';
  return null;
}

export function joinBatch(
  open: OpenBatchState | null,
  config: BatchingConfig,
  now: Date,
): JoinDecision {
  if (open === null) {
    const fireAfter = fireAfterFor(now, config, now);
    return {
      action: 'open',
      openedAt: now,
      fireAfter,
      size: 1,
      closeNow: closeReason(1, now, fireAfter, config, now),
    };
  }
  const size = open.size + 1;
  const fireAfter = fireAfterFor(open.openedAt, config, now);
  return {
    action: 'join',
    batchId: open.id,
    fireAfter,
    size,
    closeNow: closeReason(size, open.openedAt, fireAfter, config, now),
  };
}

export type CloseCheck = { close: true; reason: CloseReason } | { close: false; checkAt: Date };

export interface CoalescedBatch {
  /** Indexes into the arrivals. */
  events: number[];
  /** Seconds, on the arrivals' scale. */
  closesAt: number;
  reason: CloseReason;
}

/**
 * The batches a run of arrivals (seconds, ascending) forms under `config`, by the same rules as
 * `joinBatch` and `closeCheck`. Browser-safe, for the editor's preview.
 */
export function coalesceArrivals(
  arrivals: readonly number[],
  config: BatchingConfig,
): CoalescedBatch[] {
  const at = (seconds: number) => new Date(seconds * SECOND_MS);
  const seconds = (d: Date) => d.getTime() / SECOND_MS;
  const out: CoalescedBatch[] = [];
  type Forming = OpenBatchState & { events: number[] };
  let open = null as Forming | null;
  const closeOnTime = (b: Forming) => {
    const check = closeCheck(b, config, b.fireAfter);
    out.push({
      events: b.events,
      closesAt: seconds(b.fireAfter),
      reason: check.close ? check.reason : 'debounce',
    });
  };
  for (const [i, t] of arrivals.entries()) {
    const now = at(t);
    if (open && now.getTime() >= open.fireAfter.getTime()) {
      closeOnTime(open);
      open = null;
    }
    const joined = joinBatch(open, config, now);
    if (joined.action === 'open') {
      open = { id: String(i), openedAt: now, fireAfter: joined.fireAfter, size: 1, events: [i] };
    } else if (open) {
      open = {
        ...open,
        fireAfter: joined.fireAfter,
        size: joined.size,
        events: [...open.events, i],
      };
    }
    if (open && joined.closeNow !== null) {
      out.push({ events: open.events, closesAt: t, reason: joined.closeNow });
      open = null;
    }
  }
  if (open) closeOnTime(open);
  return out;
}

/** When the batch stays open, `checkAt` is when to look again. */
export function closeCheck(batch: OpenBatchState, config: BatchingConfig, now: Date): CloseCheck {
  const reason = closeReason(batch.size, batch.openedAt, batch.fireAfter, config, now);
  if (reason !== null) return { close: true, reason };
  return {
    close: false,
    checkAt: new Date(Math.min(batch.fireAfter.getTime(), ageLimit(batch.openedAt, config))),
  };
}
