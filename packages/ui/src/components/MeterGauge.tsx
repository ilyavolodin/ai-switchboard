import type { MeterGaugeDTO } from '@ai-switchboard/core/contract';

import { useNow } from '../hooks/useNow.js';
import { cx } from '../lib/cx.js';
import {
  GAUGE_CENTER,
  GAUGE_RADIUS,
  GAUGE_VIEWBOX,
  arcDasharray,
  ceilingMark,
  meterFraction,
} from '../lib/gauge.js';
import { isAboveCeiling, meterTimes, meterValueText, shortMeterLabel } from '../lib/meter.js';
import styles from './MeterGauge.module.css';

export type GaugeMeter = Pick<
  MeterGaugeDTO,
  | 'title'
  | 'kind'
  | 'unit'
  | 'utilization'
  | 'used'
  | 'limit'
  | 'resetsAt'
  | 'observedAt'
  | 'estimated'
  | 'stale'
  | 'ceilings'
>;

export interface MeterGaugeProps {
  meter: GaugeMeter;
  size?: 'sm' | 'node' | 'md' | 'lg';
  /** Only draw this process's ceiling marks; default: every bound process. */
  processId?: string;
  showSweepCeilings?: boolean;
  label?: 'below' | 'compact' | 'none';
}

const SIZES = {
  sm: { px: 24, stroke: 8, text: false },
  node: { px: 38, stroke: 7, text: false },
  md: { px: 44, stroke: 6, text: true },
  lg: { px: 110, stroke: 6, text: true },
} as const;

export function MeterGauge({
  meter,
  size = 'md',
  processId,
  showSweepCeilings,
  label = size === 'lg' || size === 'md' ? 'below' : 'none',
}: MeterGaugeProps) {
  const nowMs = useNow(30_000);
  const conf = SIZES[size];
  const fraction = meterFraction(meter) ?? 0;
  const value = meterValueText(meter);
  const ceilings = processId
    ? meter.ceilings.filter((c) => c.processId === processId)
    : meter.ceilings;
  const eventMarks = [...new Set(ceilings.map((c) => c.events))];
  const sweepMarks = showSweepCeilings
    ? [...new Set(ceilings.map((c) => c.sweeps))].filter((s) => !eventMarks.includes(s))
    : [];
  const above = isAboveCeiling({ ...meter, ceilings });
  const color = meter.stale ? 'var(--line-strong)' : above ? 'var(--st-err)' : 'var(--primary)';
  const { lastRead, resets: resetText } = meterTimes(meter, nowMs);

  const ariaParts = [
    `${meter.title} ${value}${meter.kind === 'allowance' && meter.used != null ? ` ${meter.unit}` : ' used'}`,
    eventMarks.length > 0
      ? `ceiling ${eventMarks.map((c) => `${Math.round(c)}%`).join(', ')}`
      : null,
    above ? 'above ceiling, throttled' : null,
    meter.stale ? `stale, ${lastRead}` : null,
    meter.estimated ? 'estimated' : null,
    resetText,
  ].filter(Boolean);

  const fontSize = value.length > 4 ? 10 : 13;

  return (
    <span className={styles.gauge} data-stale={meter.stale || undefined}>
      <svg
        className={styles.svg}
        width={conf.px}
        height={conf.px}
        viewBox={`0 0 ${GAUGE_VIEWBOX} ${GAUGE_VIEWBOX}`}
        role="img"
        aria-label={ariaParts.join(' · ')}
      >
        <circle
          cx={GAUGE_CENTER}
          cy={GAUGE_CENTER}
          r={GAUGE_RADIUS}
          fill="none"
          stroke="var(--accent-3)"
          strokeWidth={conf.stroke}
        />
        {fraction > 0 && (
          <circle
            data-part="arc"
            cx={GAUGE_CENTER}
            cy={GAUGE_CENTER}
            r={GAUGE_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={conf.stroke}
            strokeLinecap="round"
            strokeDasharray={arcDasharray(fraction)}
            transform={`rotate(-90 ${GAUGE_CENTER} ${GAUGE_CENTER})`}
          />
        )}
        {sweepMarks.map((pct) => {
          const m = ceilingMark(pct);
          return (
            <line
              key={`s${pct}`}
              data-part="sweep-ceiling"
              data-percent={pct}
              {...m}
              stroke="var(--line-strong)"
              strokeWidth={1.5}
            />
          );
        })}
        {eventMarks.map((pct) => {
          const m = ceilingMark(pct);
          return (
            <line
              key={`e${pct}`}
              data-part="ceiling"
              data-percent={pct}
              {...m}
              stroke="var(--ink)"
              strokeWidth={2}
            />
          );
        })}
        {conf.text && (
          <text
            x={GAUGE_CENTER}
            y={fontSize === 13 ? 31 : 30}
            textAnchor="middle"
            className={styles.value}
            style={{ fontSize }}
          >
            {value}
          </text>
        )}
      </svg>
      {label === 'compact' && (
        <span className={cx(styles.small, meter.stale && styles.stale)}>
          {shortMeterLabel(meter.title)} <span className="mono">{value}</span>
        </span>
      )}
      {label === 'below' && (
        <>
          <span className={styles.title}>{meter.title}</span>
          <span className={cx(styles.caption, meter.stale && styles.stale)}>
            {[meter.stale ? lastRead : resetText, meter.estimated ? 'estimated' : null]
              .filter(Boolean)
              .join(' · ') || ' '}
          </span>
        </>
      )}
    </span>
  );
}
