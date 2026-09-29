import { describe, expect, it } from 'vitest';

import { attentionItems, type AttentionInput } from './attention.js';

const now = new Date('2026-09-29T12:00:00Z');

const empty: AttentionInput = {
  now,
  sourceSilenceMinutes: 60,
  processes: [],
  sources: [],
  destinations: [],
  uncertain: [],
  turnedAway: [],
  failedPlugins: [],
};

const source = (over: Partial<AttentionInput['sources'][number]> = {}) => ({
  id: 's1',
  name: 'GitHub',
  typeId: 'github',
  enabled: true,
  pluginAvailable: true,
  status: { tone: 'ok' as const, label: 'healthy' },
  health: null,
  mode: 'push' as const,
  processCount: 1,
  lastEventAt: new Date(now.getTime() - 60_000).toISOString(),
  ...over,
});

const destination = (over: Partial<AttentionInput['destinations'][number]> = {}) => ({
  id: 'd1',
  name: 'Routines',
  typeId: 'claude-routines',
  enabled: true,
  pluginAvailable: true,
  status: { tone: 'ok' as const, label: 'healthy' },
  health: null,
  meters: [],
  ...over,
});

const kinds = (input: Partial<AttentionInput>) =>
  attentionItems({ ...empty, ...input }).map((i) => i.id);

describe('attentionItems', () => {
  it.each<[string, Partial<AttentionInput>, string[]]>([
    ['nothing to report', {}, []],
    [
      'an open breaker and a pending approval',
      {
        processes: [
          {
            id: 'p1',
            name: 'Autofix',
            breakerState: 'open',
            breakerOpenedAt: now.toISOString(),
            awaitingApproval: 2,
          },
        ],
      },
      ['breaker:p1', 'approval:p1'],
    ],
    ['a healthy, recent source', { sources: [source()] }, []],
    [
      'a silent push source that processes use',
      { sources: [source({ lastEventAt: new Date(now.getTime() - 61 * 60_000).toISOString() })] },
      ['silent:s1'],
    ],
    [
      'a source that never received an event',
      { sources: [source({ lastEventAt: null })] },
      ['silent:s1'],
    ],
    ['a silent pull source', { sources: [source({ mode: 'pull', lastEventAt: null })] }, []],
    [
      'a silent source no process uses',
      { sources: [source({ processCount: 0, lastEventAt: null })] },
      [],
    ],
    [
      'a source whose plugin is missing',
      { sources: [source({ pluginAvailable: false })] },
      ['plugin:s1'],
    ],
    [
      'an unhealthy destination',
      { destinations: [destination({ status: { tone: 'error', label: 'unhealthy' } })] },
      ['unhealthy:d1'],
    ],
    [
      'a disabled unhealthy destination',
      {
        destinations: [
          destination({ enabled: false, status: { tone: 'error', label: 'unhealthy' } }),
        ],
      },
      [],
    ],
    [
      'a stale meter, but not an estimated one',
      {
        destinations: [
          destination({
            meters: [
              {
                meterId: 'w',
                title: '5-hour window',
                stale: true,
                estimated: false,
                observedAt: null,
              },
              { meterId: 'd', title: 'daily', stale: true, estimated: true, observedAt: null },
            ],
          }),
        ],
      },
      ['stale:d1:w'],
    ],
    ['uncertain runs', { uncertain: [{ processId: 'p1', n: 3 }] }, ['uncertain:p1']],
    [
      'a disabled process that turned events away',
      {
        turnedAway: [
          { processId: 'p1', name: 'Autofix', n: 4 },
          { processId: 'p2', name: 'Other', n: 0 },
        ],
      },
      ['disabled:p1'],
    ],
    [
      'errors sort before warnings',
      {
        uncertain: [{ processId: 'p1', n: 1 }],
        failedPlugins: [{ name: '@acme/bell', status: 'failed' }],
      },
      ['pluginload:@acme/bell', 'uncertain:p1'],
    ],
  ])('%s', (_name, input, expected) => {
    expect(kinds(input)).toEqual(expected);
  });

  it('words counts and falls back to the health message', () => {
    const items = attentionItems({
      ...empty,
      processes: [
        {
          id: 'p1',
          name: 'Autofix',
          breakerState: 'closed',
          breakerOpenedAt: null,
          awaitingApproval: 0,
        },
      ],
      uncertain: [{ processId: 'p1', n: 1 }],
      turnedAway: [{ processId: 'p2', name: 'Triage', n: 1 }],
      destinations: [
        destination({
          status: { tone: 'error', label: 'unhealthy' },
          health: { message: '401 from the backend', checkedAt: now.toISOString() },
        }),
      ],
    });
    expect(items.map((i) => [i.title, i.detail])).toEqual([
      ['Routines: unhealthy', '401 from the backend'],
      [
        'Autofix: 1 uncertain run',
        'The invoke response was lost; tracking will settle it or the deadline marks it unknown.',
      ],
      [
        'Triage is disabled and turned away 1 event in 24 h',
        'It has never run. Enable it if it should take these events.',
      ],
    ]);
  });
});
