import type { ProcessSummary } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import {
  asProcessFilter,
  asProcessSort,
  filterCounts,
  flowLine,
  matchesFilter,
  matchesQuery,
  sortProcesses,
} from './processList.js';

function proc(over: Partial<ProcessSummary>): ProcessSummary {
  return {
    id: 'p',
    name: 'P',
    description: '',
    enabled: true,
    status: { tone: 'ok', label: 'healthy' },
    breakerState: 'closed',
    awaitingApproval: 0,
    dots: { matched: 0, batched: 0, gated: 0, invoked: 0, ok: 0, tones: [] },
    sparkline: [],
    nextSweepAt: null,
    dailyCap: { used: 0, limit: null },
    lastRunAt: null,
    destination: null,
    triggers: [],
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as ProcessSummary;
}

const healthy = proc({ id: 'a', name: 'Beta', sparkline: [1, 1] });
const broken = proc({ id: 'b', name: 'Alpha', status: { tone: 'error', label: 'breaker open' } });
const off = proc({
  id: 'c',
  name: 'Gamma',
  status: { tone: 'off', label: 'disabled' },
  sparkline: [5],
});

describe('matchesFilter', () => {
  it.each([
    ['all', healthy, true],
    ['healthy', healthy, true],
    ['healthy', broken, false],
    ['attention', broken, true],
    ['off', off, true],
  ] as const)('%s on %s', (filter, p, expected) => {
    expect(matchesFilter(p, filter)).toBe(expected);
  });
});

describe('matchesQuery', () => {
  const p = proc({
    name: 'Triage',
    triggers: [
      { sourceId: 's', sourceName: 'Datadog', describe: '', eventTypes: ['monitor.alert'] },
    ],
  });
  it.each([
    ['', true],
    ['  triage ', true],
    ['datadog', true],
    ['monitor.alert', true],
    ['github', false],
  ])('%j', (q, expected) => {
    expect(matchesQuery(p, q)).toBe(expected);
  });
});

describe('sortProcesses', () => {
  it.each([
    ['name', ['Alpha', 'Beta', 'Gamma']],
    ['status', ['Alpha', 'Beta', 'Gamma']],
    ['activity', ['Gamma', 'Beta', 'Alpha']],
  ] as const)('by %s', (sort, names) => {
    expect(sortProcesses([healthy, broken, off], sort).map((p) => p.name)).toEqual(names);
  });
});

describe('URL values', () => {
  it('falls back to the defaults for values it does not know', () => {
    expect(asProcessSort('name')).toBe('name');
    expect(asProcessSort('bogus')).toBe('activity');
    expect(asProcessFilter('off')).toBe('off');
    expect(asProcessFilter('')).toBe('all');
  });
});

describe('filterCounts and flowLine', () => {
  it('counts each filter', () => {
    expect(filterCounts([healthy, broken, off])).toEqual({
      all: 3,
      healthy: 1,
      attention: 1,
      off: 1,
    });
  });

  it('names the sources and destination by their short names', () => {
    const p = proc({
      destination: { id: 'd', name: 'Claude Routines — seat' },
      triggers: [
        { sourceId: 's', sourceName: 'Linear — acme', describe: '', eventTypes: [] },
        { sourceId: 's2', sourceName: 'Linear — acme', describe: '', eventTypes: [] },
      ],
    });
    expect(flowLine(p)).toBe('Linear → Claude Routines');
    expect(flowLine(proc({}))).toBe('schedule only → no destination');
  });
});
