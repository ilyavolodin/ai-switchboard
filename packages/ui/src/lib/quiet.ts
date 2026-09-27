import type { QuietWindow } from '@ai-switchboard/core/contract';

function hourOf(hhmm: string): number {
  const h = Number(hhmm.split(':')[0]);
  return Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 0;
}

/** Whether hour `h` (0–23) falls inside the window, which may wrap past midnight. */
export function isQuietHour(h: number, w: QuietWindow): boolean {
  const start = hourOf(w.start);
  const end = hourOf(w.end);
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}
