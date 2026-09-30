import { describe, expect, it } from 'vitest';

import {
  capsApply,
  checkDraft,
  doorStage,
  sourceNotes,
  storedHeaders,
  type DoorCaps,
  type DoorCounts,
  type DraftChecker,
} from './door.js';

const now = new Date('2026-01-05T09:00:00Z');
const live: DraftChecker = {
  typeId: 'fake-hook',
  eventTypes: [
    {
      type: 'pr.labeled',
      title: 'PR labeled',
      description: '',
      attributes: { type: 'object', properties: { label: { type: 'string' } } },
      examples: [],
    },
  ],
  secretValues: ['fixture-secret', 'abc'],
};
const good = {
  type: 'pr.labeled',
  occurredAt: '2026-01-05T08:59:00Z',
  artifact: { kind: 'pr', id: '1' },
  attributes: { label: 'x' },
  dedupeKey: 'pr:1',
};

describe('checkDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(checkDraft(good, live, now)).toMatchObject({ stage: null, reason: null, problems: [] });
  });

  it.each([
    ['not an object', 'nope', 'event is not an object'],
    ['an undeclared type', { ...good, type: 'other' }, 'is not declared by fake-hook'],
    ['no artifact id', { ...good, artifact: { kind: 'pr' } }, 'artifact must have a kind'],
    ['no dedupe key', { ...good, dedupeKey: '' }, 'dedupeKey is missing'],
    ['a bad time', { ...good, occurredAt: 'soon' }, 'occurredAt is not an ISO-8601 time'],
    ['a nested attribute', { ...good, attributes: { label: { a: 1 } } }, 'not a scalar'],
    ['a secret in an attribute', { ...good, attributes: { label: 'fixture-secret' } }, 'secret'],
  ])('flags %s', (_name, draft, problem) => {
    const out = checkDraft(draft, live, now);
    expect(out.stage).toBe('event_invalid');
    expect(out.reason).toContain(problem);
  });

  it('falls back to now for an unparseable time', () => {
    expect(checkDraft({ ...good, occurredAt: 'soon' }, live, now).occurredAt).toEqual(now);
  });
});

describe('doorStage', () => {
  const ok = { stage: null, reason: null, type: 'pr.labeled' } as const;
  const counts: DoorCounts = { hour: 1, day: 5 };
  const caps: DoorCaps = { eventCapPerHour: 2, eventCapPerDay: 10 };

  it.each<
    [
      string,
      { stage: 'event_invalid' | null; reason: string | null; type: string },
      { enabled: boolean; caps: DoorCaps },
      DoorCounts | null,
      string,
    ]
  >([
    ['a disabled source', ok, { enabled: false, caps }, counts, 'source_disabled'],
    [
      'an invalid event',
      { stage: 'event_invalid', reason: 'bad', type: 'pr.labeled' },
      { enabled: true, caps },
      counts,
      'event_invalid',
    ],
    [
      'a muted type',
      ok,
      { enabled: true, caps: { eventTypesEnabled: ['other'] } },
      null,
      'type_muted',
    ],
    ['the hourly cap', ok, { enabled: true, caps }, { hour: 2, day: 2 }, 'source_throttled'],
    ['the daily cap', ok, { enabled: true, caps }, { hour: 0, day: 10 }, 'source_throttled'],
    ['room under the caps', ok, { enabled: true, caps }, counts, 'received'],
    ['no caps', ok, { enabled: true, caps: {} }, null, 'received'],
  ])('%s', (_name, checked, source, c, stage) => {
    expect(doorStage(checked, source, c).stage).toBe(stage);
  });

  it('names the cap that throttled and counts an accepted event', () => {
    expect(doorStage(ok, { enabled: true, caps }, { hour: 2, day: 0 }).reason).toBe(
      'eventCapPerHour 2',
    );
    expect(doorStage(ok, { enabled: true, caps }, { hour: 0, day: 10 }).reason).toBe(
      'eventCapPerDay 10',
    );
    expect(doorStage(ok, { enabled: true, caps }, counts).counts).toEqual({ hour: 2, day: 6 });
    expect(doorStage(ok, { enabled: true, caps: {} }, null).counts).toBeNull();
  });

  it.each([
    [{}, false, false],
    [{ eventCapPerHour: 1 }, false, true],
    [{ eventCapPerDay: 1 }, true, false],
  ])('caps %j with bypass %s apply: %s', (c, bypass, want) => {
    expect(capsApply(c, bypass)).toBe(want);
  });
});

describe('stored headers and notes', () => {
  it('drops credentials and redacts headers carrying a secret', () => {
    expect(
      storedHeaders(
        { Authorization: 'Bearer x', 'x-sig': 'has fixture-secret', 'x-ok': 'abc' },
        live.secretValues,
      ),
    ).toEqual({ 'x-sig': '[redacted]', 'x-ok': 'abc' });
  });

  it.each([
    [undefined, []],
    ['one', []],
    [
      ['a', 2, '', 'b'],
      ['a', 'b'],
    ],
    [Array.from({ length: 30 }, () => 'n'), Array.from({ length: 20 }, () => 'n')],
    [['x'.repeat(600)], ['x'.repeat(500)]],
  ])('sourceNotes(%j)', (value, want) => {
    expect(sourceNotes(value)).toEqual(want);
  });
});
