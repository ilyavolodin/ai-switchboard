import { useNow } from '../hooks/useNow.js';
import { formatAbsolute, formatClock, formatRelative, formatWhen, toMs } from '../lib/format.js';
import { Tooltip } from './Tooltip.js';

export interface TimeProps {
  /** ISO timestamp; `null` renders `fallback`. */
  value: string | null | undefined;
  /** `relative` ("4 min ago"), `clock` ("07:38"), `when` ("Sat 07:00"). */
  format?: 'relative' | 'clock' | 'clock-seconds' | 'when';
  fallback?: string;
  className?: string;
}

/**
 * A time with the absolute time on hover (a tooltip and the `title`). Relative values re-render
 * every 30 s on their own.
 */
export function Time({ value, format = 'relative', fallback = '—', className }: TimeProps) {
  const nowMs = useNow(30_000);
  const ms = toMs(value);
  if (ms == null) return <span className={className}>{fallback}</span>;
  const text =
    format === 'relative'
      ? formatRelative(ms, nowMs)
      : format === 'when'
        ? formatWhen(ms, nowMs)
        : formatClock(ms, format === 'clock-seconds');
  const absolute = formatAbsolute(ms);
  return (
    <Tooltip content={absolute}>
      <time dateTime={value ?? undefined} title={absolute} className={className} tabIndex={-1}>
        {text}
      </time>
    </Tooltip>
  );
}
