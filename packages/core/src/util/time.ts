export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * SECOND_MS);
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}
