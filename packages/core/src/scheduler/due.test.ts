import { describe, expect, it } from 'vitest';

import { defaultProcessDocument, type Schedule } from '../domain/process.js';

import { dueSweep, nextSweepAt } from './due.js';

const NY = 'America/New_York';

describe('dueSweep and catchUp', () => {
  const schedule = (catchUp: Schedule['catchUp'], expr = '0 7 * * *'): Schedule => ({
    id: 'daily',
    cron: expr,
    timezone: 'UTC',
    catchUp,
    enabled: true,
  });
  const since = new Date('2026-01-01T00:00:00Z');

  it('fires the on-time tick', () => {
    expect(
      dueSweep(
        schedule('skip'),
        { lastTickAt: new Date('2026-01-06T07:00:00Z'), since },
        new Date('2026-01-07T07:00:20Z'),
      ),
    ).toEqual({ tickAt: new Date('2026-01-07T07:00:00Z'), catchUp: false });
  });

  it('tolerates a late scheduler job within the grace', () => {
    expect(
      dueSweep(
        schedule('skip'),
        { lastTickAt: new Date('2026-01-06T07:00:00Z'), since },
        new Date('2026-01-07T07:01:40Z'),
      ),
    ).toMatchObject({ catchUp: false });
  });

  it("after an outage, 'skip' fires nothing for the missed 07:00", () => {
    expect(
      dueSweep(
        schedule('skip'),
        { lastTickAt: new Date('2026-01-06T07:00:00Z'), since },
        new Date('2026-01-07T07:20:00Z'),
      ),
    ).toBeNull();
  });

  it("after an outage, 'once' fires one make-up sweep for the latest missed tick", () => {
    const out = dueSweep(
      schedule('once', '0 * * * *'),
      { lastTickAt: new Date('2026-01-07T03:00:00Z'), since },
      new Date('2026-01-07T07:20:00Z'),
    );
    expect(out).toEqual({ tickAt: new Date('2026-01-07T07:00:00Z'), catchUp: true });
    expect(
      dueSweep(
        schedule('once', '0 * * * *'),
        { lastTickAt: out!.tickAt, since },
        new Date('2026-01-07T07:21:00Z'),
      ),
    ).toBeNull();
  });

  it("'once' never reaches back more than the catch-up limit", () => {
    expect(
      dueSweep(
        schedule('once', '0 7 1 1 *'),
        { lastTickAt: null, since: new Date('2025-01-01T00:00:00Z') },
        new Date('2026-03-01T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('without history, ticks before the process was saved are not owed', () => {
    expect(
      dueSweep(
        schedule('once'),
        { lastTickAt: null, since: new Date('2026-01-07T07:10:00Z') },
        new Date('2026-01-07T07:20:00Z'),
      ),
    ).toBeNull();
  });

  it('a disabled or invalid schedule owes nothing', () => {
    const now = new Date('2026-01-07T07:00:00Z');
    expect(
      dueSweep({ ...schedule('skip'), enabled: false }, { lastTickAt: null, since }, now),
    ).toBeNull();
    expect(
      dueSweep({ ...schedule('skip'), cron: 'nope' }, { lastTickAt: null, since }, now),
    ).toBeNull();
  });

  it('fires the DST fall-back 01:30 once when the scheduler ticks every minute', () => {
    const s: Schedule = {
      id: 's',
      cron: '30 1 * * *',
      timezone: NY,
      catchUp: 'skip',
      enabled: true,
    };
    let lastTickAt: Date | null = new Date('2026-10-31T05:30:00Z');
    const fired: string[] = [];
    for (
      let t = Date.parse('2026-11-01T04:00:00Z');
      t <= Date.parse('2026-11-01T08:00:00Z');
      t += 60_000
    ) {
      const due = dueSweep(s, { lastTickAt, since }, new Date(t + 5_000));
      if (due) {
        fired.push(due.tickAt.toISOString());
        lastTickAt = due.tickAt;
      }
    }
    expect(fired).toEqual(['2026-11-01T05:30:00.000Z']);
  });
});

describe('nextSweepAt', () => {
  it('picks the earliest enabled schedule', () => {
    const doc = defaultProcessDocument('p', 'x');
    doc.schedules = [
      { id: 'a', cron: '0 9 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true },
      { id: 'b', cron: '0 8 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true },
      { id: 'c', cron: '30 7 * * *', timezone: 'UTC', catchUp: 'skip', enabled: false },
    ];
    expect(nextSweepAt(doc, new Date('2026-01-07T07:00:00Z'))?.toISOString()).toBe(
      '2026-01-07T08:00:00.000Z',
    );
    expect(nextSweepAt({ ...doc, schedules: [] }, new Date())).toBeNull();
  });

  it('follows the scheduler across a DST gap (the wall time the gap skips fires after it)', () => {
    const doc = defaultProcessDocument('p', 'x');
    doc.schedules = [{ id: 'a', cron: '30 2 * * *', timezone: NY, catchUp: 'skip', enabled: true }];
    expect(nextSweepAt(doc, new Date('2026-03-08T06:00:00Z'))?.toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });

  it('skips an invalid schedule', () => {
    const doc = defaultProcessDocument('p', 'x');
    doc.schedules = [
      { id: 'bad', cron: 'nope', timezone: 'UTC', catchUp: 'skip', enabled: true },
      { id: 'ok', cron: '0 8 * * *', timezone: 'UTC', catchUp: 'skip', enabled: true },
    ];
    expect(nextSweepAt(doc, new Date('2026-01-07T07:00:00Z'))?.toISOString()).toBe(
      '2026-01-07T08:00:00.000Z',
    );
  });
});
