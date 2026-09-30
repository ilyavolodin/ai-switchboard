export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

export function addSeconds(d: Date, s: number): Date {
  return addMs(d, s * SECOND_MS);
}

export function addMinutes(d: Date, m: number): Date {
  return addMs(d, m * MINUTE_MS);
}

export function addDays(d: Date, days: number): Date {
  return addMs(d, days * DAY_MS);
}

/** The instant `ms` before `now`: the start of a rolling window. */
export function msAgo(now: Date, ms: number): Date {
  return addMs(now, -ms);
}
