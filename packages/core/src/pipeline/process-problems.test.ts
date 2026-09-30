import { describe, expect, it } from 'vitest';

import { defaultProcessDocument, type ProcessDocument } from '../domain/process.js';

import { processProblems, type ValidationChecks, type ValidationRefs } from './process-problems.js';

const SRC = '00000000-0000-4000-8000-000000000001';
const DST = '00000000-0000-4000-8000-000000000002';
const NOTE = '00000000-0000-4000-8000-000000000003';

const refs: ValidationRefs = {
  sources: [{ id: SRC, name: 'GitHub', eventTypes: ['github.pr.labeled'] }],
  destination: {
    name: 'Routines',
    targetDefaults: {},
    targetSchema: {
      type: 'object',
      required: ['routine'],
      properties: { routine: { type: 'string' } },
    },
    budgetableUsage: new Set(['tokens']),
    meters: new Set(['five_hour']),
  },
  providers: new Set([SRC, DST]),
  notifiers: new Set([NOTE]),
};

const checks: ValidationChecks = {
  expressionError: (expr) => (expr.includes('((') ? 'syntax error' : null),
  cronError: (cron) => (cron.split(' ').length === 5 ? null : 'invalid cron'),
};

function trigger(sourceId: string, eventTypes: string[]): ProcessDocument['triggers'][number] {
  return { id: 't1', sourceId, eventTypes, describe: '', enabled: true };
}

function doc(edit: (d: ProcessDocument) => void = () => undefined): ProcessDocument {
  const d = defaultProcessDocument('Autofix', DST);
  d.destination.target = { routine: 'fix' };
  d.triggers = [trigger(SRC, ['github.pr.labeled'])];
  edit(d);
  return d;
}

describe('processProblems', () => {
  it('accepts a document whose references all resolve', () => {
    expect(processProblems(doc(), refs, checks)).toEqual([]);
  });

  it.each([
    [
      'a missing source',
      (d: ProcessDocument) => {
        d.triggers = [trigger(DST, [])];
      },
      'triggers[0] references a source that does not exist',
    ],
    [
      'an undeclared event type',
      (d: ProcessDocument) => {
        d.triggers[0]!.eventTypes = ['github.push'];
      },
      'triggers[0]: GitHub does not declare event type github.push',
    ],
    [
      'a trigger id used twice',
      (d: ProcessDocument) => {
        d.triggers.push({ ...d.triggers[0]! });
      },
      'triggers[1].id "t1" is used twice',
    ],
    [
      'a filter that does not compile',
      (d: ProcessDocument) => {
        d.triggers[0]!.filter = '((';
      },
      'triggers[0].filter: syntax error',
    ],
    [
      'a bad cron',
      (d: ProcessDocument) => {
        d.schedules = [
          { id: 's1', cron: 'daily', timezone: 'UTC', enabled: true, catchUp: 'skip' },
        ];
      },
      'schedules[0]: invalid cron',
    ],
    [
      'a target the destination does not accept',
      (d: ProcessDocument) => {
        d.destination.target = {};
      },
      "destination.target must have required property 'routine'",
    ],
    [
      'an unknown meter ceiling',
      (d: ProcessDocument) => {
        d.budgets.meterCeilings = { weekly: { events: 80, sweeps: 95 } };
      },
      'budgets.meterCeilings.weekly: Routines has no meter "weekly"',
    ],
    [
      'an unknown notifier',
      (d: ProcessDocument) => {
        d.notify = [{ notifierId: SRC, on: ['error'], template: 'x' }];
      },
      'notify[0].notifierId does not exist',
    ],
  ])('names %s', (_name, edit, problem) => {
    expect(processProblems(doc(edit), refs, checks)).toContain(problem);
  });

  it('names a destination that does not exist', () => {
    expect(processProblems(doc(), { ...refs, destination: undefined }, checks)).toEqual([
      'destination.instanceId references a destination that does not exist',
    ]);
  });

  it('skips the event-type check when the declared types are not known', () => {
    const dynamic = { ...refs, sources: [{ id: SRC, name: 'Hook', eventTypes: null }] };
    const d = doc((x) => {
      x.triggers[0]!.eventTypes = ['anything'];
    });
    expect(processProblems(d, dynamic, checks)).toEqual([]);
  });
});
