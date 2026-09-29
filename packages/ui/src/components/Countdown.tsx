import { useNow } from '../hooks/useNow.js';
import { formatAbsolute, formatDuration, toMs } from '../lib/format.js';

export interface CountdownProps {
  until: string | null | undefined;
  prefix?: string;
  done?: string;
  /** "2h10m" instead of "2 h 10 m". */
  compact?: boolean;
  className?: string;
}

export function Countdown({ until, prefix, done = 'now', compact, className }: CountdownProps) {
  const nowMs = useNow(15_000);
  const ms = toMs(until);
  if (ms == null) return null;
  const left = ms - nowMs;
  const text = left <= 0 ? done : formatDuration(left, compact);
  return (
    <span className={className} title={formatAbsolute(ms)}>
      {prefix ? `${prefix} ` : ''}
      <span className="mono">{text}</span>
    </span>
  );
}
