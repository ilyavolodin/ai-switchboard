import type { ProcessDocument } from '../domain/process.js';

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
    ? openedAt.getTime() + config.maxAgeSeconds * 1000
    : Number.POSITIVE_INFINITY;
}

function fireAfterFor(openedAt: Date, config: BatchingConfig, now: Date): Date {
  const debounced = now.getTime() + Math.max(0, config.debounceSeconds) * 1000;
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

/** When the batch stays open, `checkAt` is when to look again. */
export function closeCheck(batch: OpenBatchState, config: BatchingConfig, now: Date): CloseCheck {
  const reason = closeReason(batch.size, batch.openedAt, batch.fireAfter, config, now);
  if (reason !== null) return { close: true, reason };
  return {
    close: false,
    checkAt: new Date(Math.min(batch.fireAfter.getTime(), ageLimit(batch.openedAt, config))),
  };
}
