import { describe, expect, it } from 'vitest';

import { FakeClock } from '../clock.js';

import {
  closeCheck,
  coalesceArrivals,
  joinBatch,
  type BatchingConfig,
  type OpenBatchState,
} from './batch.js';

describe('coalesceArrivals', () => {
  const arrivals = [0, 25, 50, 70, 190, 205, 400, 430, 450, 470];

  it.each([
    [
      'debounce closes each burst',
      { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 600 },
      [
        { events: [0, 1, 2, 3], closesAt: 100, reason: 'debounce' },
        { events: [4, 5], closesAt: 235, reason: 'debounce' },
        // 430 lands exactly on the first batch's fireAfter: the close comes first.
        { events: [6], closesAt: 430, reason: 'debounce' },
        { events: [7, 8, 9], closesAt: 500, reason: 'debounce' },
      ],
    ],
    [
      'maxSize closes on the event that fills it',
      { debounceSeconds: 30, maxSize: 2, maxAgeSeconds: 600 },
      [
        { events: [0, 1], closesAt: 25, reason: 'size' },
        { events: [2, 3], closesAt: 70, reason: 'size' },
        { events: [4, 5], closesAt: 205, reason: 'size' },
        { events: [6], closesAt: 430, reason: 'debounce' },
        { events: [7, 8], closesAt: 450, reason: 'size' },
        { events: [9], closesAt: 500, reason: 'debounce' },
      ],
    ],
    [
      'maxAge caps a batch the debounce keeps open',
      { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 60 },
      [
        { events: [0, 1, 2], closesAt: 60, reason: 'age' },
        { events: [3], closesAt: 100, reason: 'debounce' },
        { events: [4, 5], closesAt: 235, reason: 'debounce' },
        { events: [6], closesAt: 430, reason: 'debounce' },
        { events: [7, 8, 9], closesAt: 490, reason: 'age' },
      ],
    ],
    [
      'batching off closes every event on its own',
      { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 },
      arrivals.map((t, i) => ({ events: [i], closesAt: t, reason: 'size' })),
    ],
  ])('%s', (_name, batching, expected) => {
    expect(coalesceArrivals(arrivals, batching)).toEqual(expected);
  });
});

const config: BatchingConfig = { debounceSeconds: 30, maxSize: 3, maxAgeSeconds: 120 };

describe('batching', () => {
  it('opens a batch whose fireAfter is now + debounce', () => {
    const clock = new FakeClock('2026-01-05T09:00:00Z');
    const d = joinBatch(null, config, clock.now());
    expect(d).toMatchObject({ action: 'open', size: 1, closeNow: null });
    expect(d.fireAfter.toISOString()).toBe('2026-01-05T09:00:30.000Z');
  });

  it('resets the debounce on every join', () => {
    const clock = new FakeClock('2026-01-05T09:00:00Z');
    const open = joinBatch(null, config, clock.now());
    const batch: OpenBatchState = {
      id: 'b1',
      openedAt: clock.now(),
      fireAfter: open.fireAfter,
      size: 1,
    };
    clock.advanceSeconds(20);
    const join = joinBatch(batch, config, clock.now());
    expect(join).toMatchObject({ action: 'join', batchId: 'b1', size: 2, closeNow: null });
    expect(join.fireAfter.toISOString()).toBe('2026-01-05T09:00:50.000Z');
    // Without the join it would have closed at 09:00:30; now it waits.
    expect(
      closeCheck(
        { ...batch, size: 2, fireAfter: join.fireAfter },
        config,
        clock.advanceSeconds(15),
      ),
    ).toEqual({
      close: false,
      checkAt: join.fireAfter,
    });
  });

  it('closes when the debounce elapses', () => {
    const start = new Date('2026-01-05T09:00:00Z');
    const batch: OpenBatchState = {
      id: 'b1',
      openedAt: start,
      fireAfter: new Date('2026-01-05T09:00:30Z'),
      size: 1,
    };
    expect(closeCheck(batch, config, new Date('2026-01-05T09:00:29Z')).close).toBe(false);
    expect(closeCheck(batch, config, new Date('2026-01-05T09:00:30Z'))).toEqual({
      close: true,
      reason: 'debounce',
    });
  });

  it('closes at maxSize on the join that reaches it', () => {
    const now = new Date('2026-01-05T09:00:10Z');
    const batch: OpenBatchState = {
      id: 'b1',
      openedAt: new Date('2026-01-05T09:00:00Z'),
      fireAfter: new Date('2026-01-05T09:00:35Z'),
      size: 2,
    };
    expect(joinBatch(batch, config, now)).toMatchObject({ size: 3, closeNow: 'size' });
  });

  it('never pushes fireAfter past maxAge, and closes at maxAge under a steady stream', () => {
    const openedAt = new Date('2026-01-05T09:00:00Z');
    const cfg = { ...config, maxSize: 1000 };
    let batch: OpenBatchState = {
      id: 'b1',
      openedAt,
      fireAfter: new Date('2026-01-05T09:00:30Z'),
      size: 1,
    };
    for (let s = 10; s <= 110; s += 10) {
      const d = joinBatch(batch, cfg, new Date(openedAt.getTime() + s * 1000));
      expect(d.closeNow).toBeNull();
      batch = { ...batch, size: d.size, fireAfter: d.fireAfter };
    }
    expect(batch.fireAfter.toISOString()).toBe('2026-01-05T09:02:00.000Z');
    const atAge = joinBatch(batch, cfg, new Date('2026-01-05T09:02:00Z'));
    expect(atAge.closeNow).toBe('age');
    expect(closeCheck(batch, cfg, new Date('2026-01-05T09:02:00Z'))).toEqual({
      close: true,
      reason: 'age',
    });
  });

  it.each([
    [
      'debounce 0 closes at once',
      { debounceSeconds: 0, maxSize: 10, maxAgeSeconds: 60 },
      'debounce',
    ],
    ['maxSize 1 closes at once', { debounceSeconds: 30, maxSize: 1, maxAgeSeconds: 60 }, 'size'],
  ])('%s', (_name, cfg, reason) => {
    expect(joinBatch(null, cfg, new Date('2026-01-05T09:00:00Z')).closeNow).toBe(reason);
  });

  it('maxAgeSeconds 0 means no age cap', () => {
    const cfg = { debounceSeconds: 30, maxSize: 10, maxAgeSeconds: 0 };
    const d = joinBatch(null, cfg, new Date('2026-01-05T09:00:00Z'));
    expect(d.closeNow).toBeNull();
    expect(d.fireAfter.toISOString()).toBe('2026-01-05T09:00:30.000Z');
  });

  it('batching off (debounce 0, max size 1, max age 0) closes every batch on arrival', () => {
    // What the UI's "Batch events" switch writes when off: one run per event, nothing waits.
    const off = { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 };
    const now = new Date('2026-01-05T09:00:00Z');
    const d = joinBatch(null, off, now);
    expect(d).toMatchObject({ action: 'open', size: 1, closeNow: 'size' });
    expect(d.fireAfter.toISOString()).toBe(now.toISOString());
    expect(
      joinBatch(null, { ...off, debounceSeconds: 300, maxAgeSeconds: 600 }, now).closeNow,
    ).toBe('size');
  });
});
