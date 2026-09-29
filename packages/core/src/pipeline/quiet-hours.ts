import { DateTime } from 'luxon';

import type { QuietWindow } from '../domain/process.js';

function minutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * `start == end` is an empty window. An overnight window (`22:00`–`07:00`) belongs to the day it
 * starts on, so `days: [5]` covers Friday 22:00 to Saturday 07:00.
 */
export function inQuietHours(window: QuietWindow, now: Date, defaultTimezone: string): boolean {
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === null || end === null || start === end) return false;
  let local = DateTime.fromJSDate(now, { zone: window.timezone ?? defaultTimezone });
  if (!local.isValid) local = DateTime.fromJSDate(now, { zone: 'UTC' });
  const t = local.hour * 60 + local.minute;
  const days = window.days && window.days.length > 0 ? window.days : null;
  const today = local.weekday;
  const yesterday = today === 1 ? 7 : today - 1;
  if (start < end) {
    return t >= start && t < end && (days === null || days.includes(today));
  }
  if (t >= start) return days === null || days.includes(today);
  if (t < end) return days === null || days.includes(yesterday);
  return false;
}
