/**
 * Formatting helpers shared by every screen: relative and absolute times, compact durations,
 * counts. The copy follows the canvas: "2 h 10 m", "4 min ago", "48.2k".
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parses an ISO string to epoch ms; `null` for missing or invalid values. */
export function toMs(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago", or "in 5 min" for future times. */
export function formatRelative(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const future = diff > 0;
  let text: string;
  if (abs < 45_000) return 'just now';
  if (abs < HOUR) text = `${Math.round(abs / MINUTE)} min`;
  else if (abs < DAY) text = `${Math.round(abs / HOUR)} h`;
  else text = `${Math.round(abs / DAY)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Compact duration, e.g. "2 h 10 m", "38 m", "45 s", "3 d 4 h". `compact` drops spaces: "2h10m". */
export function formatDuration(ms: number, compact = false): string {
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(ms);
  const d = Math.floor(rest / DAY);
  rest -= d * DAY;
  const h = Math.floor(rest / HOUR);
  rest -= h * HOUR;
  const m = Math.floor(rest / MINUTE);
  rest -= m * MINUTE;
  const s = Math.floor(rest / 1000);
  const parts: [number, string][] = [];
  if (d > 0) parts.push([d, 'd'], [h, 'h']);
  else if (h > 0) parts.push([h, 'h'], [m, 'm']);
  else if (m > 0) parts.push([m, 'm']);
  else parts.push([s, 's']);
  const shown = parts.filter(([v], i) => i === 0 || v > 0);
  const sep = compact ? '' : ' ';
  return sign + shown.map(([v, u]) => `${v}${sep}${u}`).join(sep);
}

/** Seconds as a duration ("9 m 12 s" for longer runs keeps seconds). */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m} m ${s} s` : `${m} m`;
  return formatDuration(seconds * 1000);
}

const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** Full absolute time, shown on hover next to every relative time. */
export function formatAbsolute(ms: number): string {
  return absoluteFormat.format(new Date(ms));
}

/** "07:38" or "07:38:12" in the viewer's timezone. */
export function formatClock(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}

/** "Sat 07:00" when the time is within a week, else "Sep 12 07:00". */
export function formatWhen(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  const date = new Date(ms);
  if (Math.abs(ms - nowMs) < 6 * DAY) {
    const sameDay = new Date(nowMs).toDateString() === date.toDateString();
    if (sameDay) return time;
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** 48213 → "48.2k", 1_200_000 → "1.2M". */
export function formatCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}

/** 0.62 → "62%". Values are fractions 0–1. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Value with its unit as executors declare it: tokens, seconds, usd, count. */
export function formatUsage(value: number, unit: string): string {
  switch (unit) {
    case 'usd':
      return `$${value.toFixed(2)}`;
    case 'seconds':
      return formatSeconds(value);
    case 'tokens':
      return `${formatCount(value)} tokens`;
    case 'count':
      return formatCount(value);
    default:
      return `${formatCount(value)} ${unit}`;
  }
}

/** Short, human word for an ISO weekday list: [1..5] → "Mon–Fri". */
export function formatDays(days: number[] | undefined): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (!days || days.length === 0 || days.length === 7) return 'every day';
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] ?? 0) + 1);
  if (contiguous && sorted.length > 2) {
    return `${names[(sorted[0] ?? 1) - 1] ?? ''}–${names[(sorted[sorted.length - 1] ?? 7) - 1] ?? ''}`;
  }
  return sorted.map((d) => names[d - 1] ?? String(d)).join(', ');
}
