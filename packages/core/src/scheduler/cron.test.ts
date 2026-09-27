import { describe, expect, it } from 'vitest';

import type { Schedule } from '../domain/process.js';
import { defaultProcessDocument } from '../domain/process.js';

import { describeCron, nextTicks, parseCron, ticksBetween, type ParsedCron } from './cron.js';
import { dueSweep, nextSweepAt } from './due.js';
import { cronPreview } from './preview.js';

function cron(expr: string): ParsedCron {
  const p = parseCron(expr);
  if (!p.ok) throw new Error(p.error);
  return p.cron;
}

const iso = (ds: Date[]) => ds.map((d) => d.toISOString());
const NY = 'America/New_York';

describe('parseCron', () => {
  it.each([
    ['0 7 * * *', true],
    ['*/15 9-17 * * 1-5', true],
    ['0 0 * * mon-fri', true],
    ['0 12 1 jul *', true],
    ['@daily', true],
    ['@hourly', true],
    ['@reboot', false],
    ['0 0 * * * *', false],
    ['61 * * * *', false],
    ['0 0 L * *', false],
    ['0 0 * * 5#2', false],
    ['bogus', false],
    ['', false],
  ])('%j valid: %s', (expr, ok) => {
    expect(parseCron(expr).ok).toBe(ok);
  });

  it('treats day-of-month and day-of-week as OR when both are restricted', () => {
    // 2026-01-01 is a Thursday; the 5th is a Monday.
    const c = cron('0 9 1 * 1');
    const ticks = ticksBetween(
      c,
      'UTC',
      new Date('2025-12-31T00:00:00Z'),
      new Date('2026-01-13T00:00:00Z'),
    );
    expect(iso(ticks)).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-05T09:00:00.000Z',
      '2026-01-12T09:00:00.000Z',
    ]);
  });
});

describe('cron across DST (America/New_York)', () => {
  it('spring forward: 02:30 does not exist on 2026-03-08 and fires once, right after the gap', () => {
    const ticks = ticksBetween(
      cron('30 2 * * *'),
      NY,
      new Date('2026-03-07T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
    );
    expect(iso(ticks)).toEqual([
      '2026-03-07T07:30:00.000Z', // 02:30 EST
      '2026-03-08T07:00:00.000Z', // 03:00 EDT, the first instant after the gap
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
    ]);
  });

  it('spring forward: several skipped matches still fire once', () => {
    const ticks = ticksBetween(
      cron('*/20 2 * * *'),
      NY,
      new Date('2026-03-08T06:00:00Z'),
      new Date('2026-03-08T08:00:00Z'),
    );
    expect(iso(ticks)).toEqual(['2026-03-08T07:00:00.000Z']);
  });

  it('fall back: 01:30 happens twice on 2026-11-01 and fires once, on the first', () => {
    const ticks = ticksBetween(
      cron('30 1 * * *'),
      NY,
      new Date('2026-10-31T00:00:00Z'),
      new Date('2026-11-03T00:00:00Z'),
    );
    expect(iso(ticks)).toEqual([
      '2026-10-31T05:30:00.000Z', // 01:30 EDT
      '2026-11-01T05:30:00.000Z', // 01:30 EDT (first pass); 06:30Z is the repeat and does not fire
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
  });

  it('fall back: an hourly cron fires 01:00 once', () => {
    const ticks = ticksBetween(
      cron('0 * * * *'),
      NY,
      new Date('2026-11-01T03:30:00Z'),
      new Date('2026-11-01T08:30:00Z'),
    );
    expect(iso(ticks)).toEqual([
      '2026-11-01T04:00:00.000Z', // 00:00 EDT
      '2026-11-01T05:00:00.000Z', // 01:00 EDT
      '2026-11-01T07:00:00.000Z', // 02:00 EST
      '2026-11-01T08:00:00.000Z', // 03:00 EST
    ]);
  });

  it('a daily 07:00 keeps local time across the change', () => {
    const ticks = ticksBetween(
      cron('0 7 * * *'),
      NY,
      new Date('2026-03-07T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
    );
    expect(iso(ticks)).toEqual([
      '2026-03-07T12:00:00.000Z',
      '2026-03-08T11:00:00.000Z',
      '2026-03-09T11:00:00.000Z',
    ]);
  });
});

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
    // Once it has fired, the next minute owes nothing.
    expect(
      dueSweep(
        schedule('once', '0 * * * *'),
        { lastTickAt: out!.tickAt, since },
        new Date('2026-01-07T07:21:00Z'),
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

describe('previews', () => {
  it('describes and lists the next three times', () => {
    const out = cronPreview(
      { cron: '0 7 * * 1-5', timezone: NY },
      new Date('2026-01-09T00:00:00Z'),
    );
    expect(out.valid).toBe(true);
    expect(out.description).toMatch(/07:00/);
    expect(out.next).toEqual([
      '2026-01-09T12:00:00.000Z',
      '2026-01-12T12:00:00.000Z',
      '2026-01-13T12:00:00.000Z',
    ]);
  });

  it('rejects an invalid cron or timezone', () => {
    expect(cronPreview({ cron: '0 7 * *', timezone: 'UTC' }, new Date()).valid).toBe(false);
    expect(cronPreview({ cron: '0 7 * * *', timezone: 'Mars/Olympus' }, new Date()).error).toMatch(
      /timezone/,
    );
  });

  it('nextSweepAt picks the earliest enabled schedule', () => {
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

  it('finds a leap-day cron years ahead quickly', () => {
    const started = Date.now();
    const [next] = nextTicks(cron('0 0 29 2 *'), 'UTC', new Date('2026-03-01T00:00:00Z'), 1);
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(describeCron('0 7 * * *')).toMatch(/07:00/);
  });
});
