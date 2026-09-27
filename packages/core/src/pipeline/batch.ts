/**
 * Stage 4, batch. A dispatch joins its process's open batch for its batch key (or opens one) and
 * pushes `fireAfter` to `now + debounceSeconds`. A batch closes at `maxSize`, at `maxAgeSeconds`
 * since it opened, or when the debounce elapses. `maxAgeSeconds: 0` means no age cap.
 */

export interface BatchingConfig {
  debounceSeconds: number;
  maxSize: number;
  maxAgeSeconds: number;
}

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

/** Join `open` (or open a new batch when there is none) at `now`. */
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

/** Should an open batch close at `now`? When not, `checkAt` is when to look again. */
export function closeCheck(batch: OpenBatchState, config: BatchingConfig, now: Date): CloseCheck {
  const reason = closeReason(batch.size, batch.openedAt, batch.fireAfter, config, now);
  if (reason !== null) return { close: true, reason };
  return {
    close: false,
    checkAt: new Date(Math.min(batch.fireAfter.getTime(), ageLimit(batch.openedAt, config))),
  };
}

/** Open batches of one process, by batch key. */
export type OpenBatches = Readonly<Record<string, OpenBatchState | undefined>>;

/**
 * The batch stage as a reducer over a process's open batches: one arrival with its batch key.
 * Events with different keys go to different batches ("one run per repository"). A batch that
 * closes on this arrival leaves the state.
 */
export function batchArrival(
  state: OpenBatches,
  key: string,
  config: BatchingConfig,
  now: Date,
  newId: () => string,
): { state: OpenBatches; decision: JoinDecision & { key: string; batchId: string } } {
  const decision = joinBatch(state[key] ?? null, config, now);
  const batchId = decision.action === 'join' ? decision.batchId : newId();
  const openedAt = decision.action === 'join' ? (state[key]?.openedAt ?? now) : decision.openedAt;
  const next: Record<string, OpenBatchState | undefined> = { ...state };
  next[key] =
    decision.closeNow === null
      ? { id: batchId, openedAt, fireAfter: decision.fireAfter, size: decision.size }
      : undefined;
  return { state: next, decision: { ...decision, key, batchId } };
}
