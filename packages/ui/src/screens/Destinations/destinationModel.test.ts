import type { MeterSpec, PluginTypeDTO, UsageHistoryResponse } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import {
  describeDestinationType,
  enableDestinationPrompt,
  estimatedMeters,
  runProcesses,
  runStatusSeries,
} from './destinationModel.js';

describe('destinationModel', () => {
  it('describes a type by tracking, meters and idempotency', () => {
    expect(
      describeDestinationType({
        tracking: 'poll',
        meters: [{}],
        idempotentInvoke: true,
      } as unknown as PluginTypeDTO),
    ).toBe('poll tracking · 1 meter · idempotent');
    expect(describeDestinationType({} as PluginTypeDTO)).toBe('no meters · not idempotent');
  });

  it('holds the processes bound to a disabled destination', () => {
    const p = enableDestinationPrompt({ name: 'Routines', processCount: 3 }, false);
    expect(p).toMatchObject({ confirmLabel: 'Disable destination', danger: true });
    expect(p.consequence).toMatch(/its 3 processes are held/);
  });

  it('keeps only run statuses that occurred', () => {
    const usage = {
      runsByStatus: [
        { day: '2026-03-01', counts: { ok: 2 } },
        { day: '2026-03-02', counts: { ok: 1, error: 1 } },
      ],
    } as unknown as UsageHistoryResponse;
    expect(runStatusSeries(usage).map((s) => [s.id, s.values])).toEqual([
      ['ok', [2, 1]],
      ['error', [0, 1]],
    ]);
  });

  it('lists meters the core estimates', () => {
    const specs = [{ id: 'a', estimate: {} }, { id: 'b' }, { id: 'c' }] as unknown as MeterSpec[];
    expect(estimatedMeters(specs, [{ meterId: 'c', estimated: true }]).map((m) => m.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('lists each process once', () => {
    expect(
      runProcesses([
        { processId: 'p1', processName: 'A' },
        { processId: 'p1', processName: 'A' },
        { processId: 'p2', processName: 'B' },
      ]),
    ).toEqual([
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
    ]);
  });
});
