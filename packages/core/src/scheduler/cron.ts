import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';
import { DateTime } from 'luxon';

import { errorText } from '../util/errors.js';
import { addDays, HOUR_MS, MINUTE_MS } from '../util/time.js';

/**
 * DST rules: a wall time skipped by a spring-forward gap fires once, at the first instant after
 * the gap; a wall time repeated by a fall-back fold fires once, on its first occurrence.
 */

export interface ParsedCron {
  source: string;
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const ALIASES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly']);

export type CronParse = { ok: true; cron: ParsedCron } | { ok: false; error: string };

function numbers(values: readonly (number | string)[]): Set<number> {
  const out = new Set<number>();
  for (const v of values) if (typeof v === 'number') out.add(v);
  return out;
}

/**
 * A pure function's cache, not state: the scheduler re-reads every schedule each tick, and a parse
 * result depends only on the text. Bounded, oldest entry evicted first.
 */
const PARSED = new Map<string, CronParse>();
const PARSED_LIMIT = 1000;

export function parseCron(expression: string): CronParse {
  const hit = PARSED.get(expression);
  if (hit) return hit;
  const parsed = parseUncached(expression);
  if (PARSED.size >= PARSED_LIMIT) {
    const oldest = PARSED.keys().next();
    if (oldest.done !== true) PARSED.delete(oldest.value);
  }
  PARSED.set(expression, parsed);
  return parsed;
}

function parseUncached(expression: string): CronParse {
  const source = expression.trim().replace(/\s+/g, ' ');
  if (source === '') return { ok: false, error: 'cron expression is empty' };
  if (source.startsWith('@')) {
    if (!ALIASES.has(source.toLowerCase())) {
      return { ok: false, error: `unsupported alias ${source}` };
    }
  } else {
    const fields = source.split(' ');
    if (fields.length !== 5) {
      return {
        ok: false,
        error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
      };
    }
    const names =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\b/g;
    if (/[lw#?]/.test(source.toLowerCase().replace(names, ''))) {
      return { ok: false, error: 'L, W, # and ? are not supported' };
    }
  }
  try {
    const parsed = CronExpressionParser.parse(
      source.startsWith('@') ? source.toLowerCase() : source,
    );
    const f = parsed.fields;
    return {
      ok: true,
      cron: {
        source,
        minute: numbers(f.minute.values),
        hour: numbers(f.hour.values),
        dayOfMonth: numbers(f.dayOfMonth.values),
        month: numbers(f.month.values),
        dayOfWeek: new Set([...numbers(f.dayOfWeek.values)].map((d) => d % 7)),
        domRestricted: !f.dayOfMonth.isWildcard,
        dowRestricted: !f.dayOfWeek.isWildcard,
      },
    };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export function isValidTimezone(timezone: string): boolean {
  // Any fixed instant will do; the clock plays no part in whether a zone exists.
  return DateTime.fromMillis(0).setZone(timezone).isValid;
}

interface Wall {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number; // 0 = Sunday
}

function dayMatches(cron: ParsedCron, w: Wall): boolean {
  if (!cron.month.has(w.month)) return false;
  const dom = cron.dayOfMonth.has(w.day);
  const dow = cron.dayOfWeek.has(w.weekday);
  // Vixie cron: when both day fields are restricted, either may match.
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

function wallOf(dt: DateTime): Wall {
  return {
    minute: dt.minute,
    hour: dt.hour,
    day: dt.day,
    month: dt.month,
    weekday: dt.weekday % 7,
  };
}

function matchesWall(cron: ParsedCron, w: Wall): boolean {
  return dayMatches(cron, w) && cron.hour.has(w.hour) && cron.minute.has(w.minute);
}

/** Does a wall time skipped by a gap just before `t` match? */
function gapMatches(cron: ParsedCron, t: DateTime, prev: DateTime): boolean {
  // The wall clock moved 1 + jump minutes between prev and t; `jump` wall minutes never existed.
  const jump = t.offset - prev.offset;
  if (jump <= 0) return false;
  const base = Date.UTC(prev.year, prev.month - 1, prev.day, prev.hour, prev.minute);
  for (let i = 1; i <= jump; i++) {
    const naive = new Date(base + i * MINUTE_MS);
    const w: Wall = {
      minute: naive.getUTCMinutes(),
      hour: naive.getUTCHours(),
      day: naive.getUTCDate(),
      month: naive.getUTCMonth() + 1,
      weekday: naive.getUTCDay(),
    };
    if (matchesWall(cron, w)) return true;
  }
  return false;
}

/** True when `t`'s wall time already occurred earlier (the second pass of a fall-back fold). */
function isRepeat(t: DateTime, zone: string): boolean {
  const first = DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute },
    { zone },
  );
  return first.toMillis() !== t.toMillis();
}

export interface TickOptions {
  limit?: number;
  /** Scan steps before giving up; far more than any real range needs, since steps skip ahead. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 2_000_000;

/** A scan ran out of steps before reaching the end of its range; its ticks would be incomplete. */
export class CronScanLimitError extends Error {
  override readonly name = 'CronScanLimitError';
}

/** Ascending; instants are whole UTC minutes. Throws `CronScanLimitError` rather than truncate. */
export function ticksBetween(
  cron: ParsedCron,
  timezone: string,
  fromExclusive: Date,
  toInclusive: Date,
  options: TickOptions = {},
): Date[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const out: Date[] = [];
  let t = Math.floor(fromExclusive.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = toInclusive.getTime();
  let steps = 0;
  while (t <= end && out.length < limit) {
    if (steps++ >= maxSteps) {
      throw new CronScanLimitError(
        `${cron.source}: no end of range after ${maxSteps} steps (at ${new Date(t).toISOString()})`,
      );
    }
    const dt = DateTime.fromMillis(t, { zone: timezone });
    const prev = DateTime.fromMillis(t - MINUTE_MS, { zone: timezone });
    const w = wallOf(dt);
    const repeat = isRepeat(dt, timezone);
    const fires = (!repeat && matchesWall(cron, w)) || gapMatches(cron, dt, prev);
    if (fires) {
      out.push(new Date(t));
      t += MINUTE_MS;
      continue;
    }
    if (!repeat && dt.offset === prev.offset) {
      // Skip ahead when the day or the hour cannot match. Gaps sit on hour boundaries, which
      // these jumps always land on, so the check above still sees the instant after a gap.
      if (!dayMatches(cron, w)) {
        t = Math.max(t + MINUTE_MS, dt.startOf('day').plus({ days: 1 }).toMillis());
        continue;
      }
      if (!cron.hour.has(w.hour)) {
        t = Math.max(t + MINUTE_MS, dt.startOf('hour').toMillis() + HOUR_MS);
        continue;
      }
    }
    t += MINUTE_MS;
  }
  return out;
}

export function nextTicks(
  cron: ParsedCron,
  timezone: string,
  after: Date,
  count: number,
  horizonDays = 366 * 5,
): Date[] {
  return ticksBetween(cron, timezone, after, addDays(after, horizonDays), { limit: count });
}

export function describeCron(expression: string): string | null {
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: true, verbose: false });
  } catch {
    return null;
  }
}
