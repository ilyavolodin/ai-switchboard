import { useNow } from '../hooks/useNow.js';
import { formatAbsolute, formatClock, formatRelative, formatWhen, toMs } from '../lib/format.js';
import { Tooltip } from './Tooltip.js';

export interface TimeProps {
  value: string | null | undefined;
  format?: 'relative' | 'clock' | 'clock-seconds' | 'when';
  fallback?: string;
  className?: string;
}

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
