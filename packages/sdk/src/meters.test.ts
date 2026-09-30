import { describe, expect, it } from 'vitest';

import { meterReading } from './meters.js';

const observedAt = '2026-09-30T12:00:00.000Z';

describe('meterReading', () => {
  it.each([
    [25, 100, 25],
    [150, 100, 100],
    [0, 100, 0],
    [5, 0, 100],
  ])('used %d of %d is %d%%', (used, limit, utilization) => {
    expect(meterReading({ id: 'm', used, limit, observedAt })).toEqual({
      id: 'm',
      used,
      limit,
      utilization,
      observedAt,
    });
  });

  it.each([
    [37, 37],
    [-4, 0],
    [120, 100],
    [Number.NaN, 0],
  ])('utilization %d is clamped to %d', (given, utilization) => {
    expect(meterReading({ id: 'm', utilization: given, observedAt }).utilization).toBe(utilization);
  });

  it('keeps resetsAt when given', () => {
    const resetsAt = '2026-09-30T13:00:00.000Z';
    expect(meterReading({ id: 'm', utilization: 1, resetsAt, observedAt }).resetsAt).toBe(resetsAt);
  });
});
