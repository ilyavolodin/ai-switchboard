import { chartValue } from '../lib/chart.js';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Values are appended to it. */
  label?: string;
  color?: string;
}

export function Sparkline({
  values,
  width = 72,
  height = 20,
  label = 'Trend',
  color = 'var(--primary)',
}: SparklineProps) {
  const clean = values.map(chartValue);
  // A one-point polyline is invisible, so a lone value is drawn flat across the width.
  const drawn = clean.length === 1 ? [clean[0] ?? 0, clean[0] ?? 0] : clean;
  const max = Math.max(1, ...drawn);
  const step = drawn.length > 1 ? width / (drawn.length - 1) : 0;
  const points = drawn
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
