import type { ReactNode } from 'react';

import { chartValue } from '../lib/chart.js';
import styles from './BarChart.module.css';

export interface BarSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

export interface BarChartProps {
  labels: string[];
  series: BarSeries[];
  stacked?: boolean;
  ariaLabel: string;
  height?: number;
  /** Indices of partial buckets, drawn dashed. */
  partial?: number[];
  showLegend?: boolean;
  formatValue?: (v: number) => string;
  labelEvery?: number;
}

const W = 340;

export function BarChart({
  labels,
  series: given,
  stacked = false,
  ariaLabel,
  height = 132,
  partial = [],
  showLegend = true,
  formatValue = (v) => String(Math.round(v)),
  labelEvery = 1,
}: BarChartProps) {
  const series = given.map((s) => ({
    ...s,
    values: labels.map((_, i) => chartValue(s.values[i])),
  }));
  const plotTop = 10;
  const plotBottom = height - 22;
  const plotH = plotBottom - plotTop;
  const n = Math.max(1, labels.length);
  const slot = W / n;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...(stacked ? totals : series.flatMap((s) => s.values)));
  const peaks = labels.map((_, i) =>
    stacked ? (totals[i] ?? 0) : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  );
  const maxIndex = peaks.findIndex((v) => v === max);
  const barW = stacked
    ? Math.min(24, slot * 0.6)
    : Math.min(12, (slot * 0.8) / Math.max(1, series.length));

  return (
    <div className={styles.chart}>
      {showLegend && series.length > 1 && (
        <div className={styles.legend} aria-hidden="true">
          {series.map((s) => (
            <span key={s.id} className={styles.key}>
              <span className={styles.swatch} style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg className={styles.svg} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        <g stroke="var(--border-1)" strokeWidth={1}>
          <line x1={0} y1={plotTop} x2={W} y2={plotTop} />
          <line x1={0} y1={plotTop + plotH / 2} x2={W} y2={plotTop + plotH / 2} />
          <line x1={0} y1={plotBottom} x2={W} y2={plotBottom} />
        </g>
        {labels.map((label, i) => {
          const cx = slot * i + slot / 2;
          const isPartial = partial.includes(i);
          const bars: ReactNode[] = [];
          if (stacked) {
            let y = plotBottom;
            series.forEach((s) => {
              const v = s.values[i] ?? 0;
              if (v <= 0) return;
              const h = (v / max) * plotH;
              y -= h;
              bars.push(
                <rect
                  key={s.id}
                  data-series={s.id}
                  x={cx - barW / 2}
                  y={y}
                  width={barW}
                  height={h}
                  rx={1.5}
                  fill={isPartial ? 'var(--accent-3)' : s.color}
                  stroke={isPartial ? 'var(--border-4)' : undefined}
                  strokeDasharray={isPartial ? '3 2' : undefined}
                >
                  <title>{`${label} · ${s.label}: ${formatValue(v)}`}</title>
                </rect>,
              );
            });
          } else {
            const groupW = barW * series.length + 2 * (series.length - 1);
            series.forEach((s, j) => {
              const v = s.values[i] ?? 0;
              const h = (v / max) * plotH;
              bars.push(
                <rect
                  key={s.id}
                  data-series={s.id}
                  x={cx - groupW / 2 + j * (barW + 2)}
                  y={plotBottom - h}
                  width={barW}
                  height={Math.max(h, v > 0 ? 1 : 0)}
                  rx={2}
                  fill={isPartial ? 'var(--accent-3)' : s.color}
                  stroke={isPartial ? 'var(--border-4)' : undefined}
                  strokeDasharray={isPartial ? '3 2' : undefined}
                >
                  <title>{`${label} · ${s.label}: ${formatValue(v)}`}</title>
                </rect>,
              );
            });
          }
          const top = peaks[i] ?? 0;
          const showMax = i === maxIndex && max > 0;
          return (
            <g key={`${label}-${i}`}>
              {bars}
              {showMax && (
                <text
                  x={cx}
                  y={plotBottom - (top / max) * plotH - 4}
                  textAnchor="middle"
                  className={styles.value}
                >
                  {formatValue(top)}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" className={styles.tick}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <table className="visually-hidden">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={`${label}-${i}`}>
              <th scope="row">{label}</th>
              {series.map((s) => (
                <td key={s.id}>{formatValue(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
