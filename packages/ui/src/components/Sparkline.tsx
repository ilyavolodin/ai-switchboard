export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Accessible description; values are appended. */
  label?: string;
  color?: string;
}

/** A tiny line of values (runs per day over 7 days on process cards). */
export function Sparkline({
  values,
  width = 72,
  height = 20,
  label = 'Trend',
  color = 'var(--primary)',
}: SparklineProps) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${values.join(', ')}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
