import type { PluginTypeDTO, SourceStatsResponse } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import {
  describeSourceType,
  enableSourcePrompt,
  modeLabel,
  stageSeries,
  statBuckets,
  typeSeries,
  typeSplit,
} from './sourceModel.js';

const stats = {
  buckets: [
    { hour: '2026-03-02T10:00:00Z', byType: { a: 2, b: 1 }, byStage: { matched: 3 } },
    { hour: '2026-03-02T11:00:00Z', byType: { a: 1 }, byStage: { source_throttled: 1 } },
    { hour: '2026-03-03T11:00:00Z', byType: { b: 4 }, byStage: { matched: 4 } },
  ],
} as unknown as SourceStatsResponse;

describe('source stats', () => {
  it('keeps hours for 24 h and folds them into days otherwise', () => {
    expect(statBuckets(stats, '24h')).toHaveLength(3);
    const days = statBuckets(stats, '7d');
    expect(days).toHaveLength(2);
    expect(days[0]?.byType).toEqual({ a: 3, b: 1 });
  });

  it('orders type series by volume and drops empty stages', () => {
    const days = statBuckets(stats, '7d');
    expect(typeSeries(days).map((s) => s.id)).toEqual(['b', 'a']);
    expect(stageSeries(days).map((s) => s.id)).toEqual(['matched', 'source_throttled']);
  });

  it('splits the day by event type', () => {
    const split = typeSplit({
      eventsByType24h: [
        { type: 'x', count: 1 },
        { type: 'y', count: 3 },
      ],
    });
    expect(split.total).toBe(4);
    expect(split.parts.map((p) => [p.type, p.share])).toEqual([
      ['y', 0.75],
      ['x', 0.25],
    ]);
  });
});

describe('source copy', () => {
  it.each([
    ['push', 'push · webhook'],
    ['pull', 'pull · polls'],
    ['both', 'push and pull'],
  ] as const)('mode %s', (mode, label) => {
    expect(modeLabel(mode)).toBe(label);
  });

  it('describes a type by mode, event types and provisioning', () => {
    const t = {
      mode: 'push',
      eventTypes: [{}],
      provisionSupported: true,
    } as unknown as PluginTypeDTO;
    expect(describeSourceType(t)).toBe('push · 1 event type · registers its webhook');
    expect(describeSourceType({ mode: 'both', dynamicEventTypes: true } as PluginTypeDTO)).toBe(
      'push and pull · dynamic event types',
    );
  });

  it('names the processes a disable affects', () => {
    const p = enableSourcePrompt({ name: 'GitHub', processCount: 2 }, false);
    expect(p).toMatchObject({ title: 'Disable GitHub?', danger: true });
    expect(p.consequence).toMatch(/its 2 processes stop/);
    expect(enableSourcePrompt({ name: 'GitHub', processCount: 1 }, true).consequence).toBe(
      'Events from GitHub flow to its 1 process again.',
    );
  });
});
