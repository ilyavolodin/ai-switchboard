import type { MeterHistoryResponse } from '@ai-switchboard/core/contract';

import { chartValue } from '../lib/chart.js';
import { toMs } from '../lib/format.js';
import { runStatusTone, toneVars } from '../lib/tone.js';
import styles from './MeterBand.module.css';

export interface MeterBandProps {
  meters: MeterHistoryResponse['meters'];
  runs?: MeterHistoryResponse['runs'];
  processId?: string;
  /** Epoch ms; defaults to the data's extent. */
  from?: number;
  to?: number;
  ariaLabel?: string;
}

const W = 640;
const H = 150;
const TOP = 10;
const BOTTOM = 120;
const COLORS = ['var(--primary)', 'var(--sky)', 'var(--teal)', 'var(--berry)'];
const DASH = [undefined, '4 3', '2 3', '6 3'];

const yFor = (pct: number) => BOTTOM - (Math.min(100, chartValue(pct)) / 100) * (BOTTOM - TOP);

/**
 * A reading holds until the next one, so a lone reading is drawn flat to the end of the extent
 * (a one-point polyline would be invisible).
 */
function bandPoints(
  readings: MeterBandProps['meters'][number]['readings'],
  x: (t: number) => number,
  start: number,
  end: number,
): string {
  const points = readings.flatMap((r) => {
    const t = toMs(r.t);
    return t == null ? [] : [{ t, u: r.utilization }];
  });
  const only = points.length === 1 ? points[0] : undefined;
  if (only) points.push({ t: Math.max(end, only.t + 1), u: only.u });
  return points.map((p) => `${x(p.t).toFixed(1)},${yFor(p.u).toFixed(1)}`).join(' ');
}

export function MeterBand({ meters, runs = [], processId, from, to, ariaLabel }: MeterBandProps) {
  // Runs usually land after the latest reading, so the extent covers them too.
  const times = [
    ...meters.flatMap((m) => m.readings.map((r) => toMs(r.t))),
    ...runs.map((r) => toMs(r.t)),
  ].filter((t): t is number => t != null);
  const start = from ?? (times.length ? Math.min(...times) : 0);
  const end = to ?? (times.length ? Math.max(...times) : start + 1);
  const span = Math.max(1, end - start);
  const x = (t: number) => ((t - start) / span) * W;
  const first = meters[0];
  const ceiling =
    first && first.ceilings.length > 0 ? Math.min(...first.ceilings.map((c) => c.events)) : null;

  return (
    <div className={styles.band}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? `Meter history with ${runs.length} run markers`}
      >
        <line x1={0} y1={TOP} x2={W} y2={TOP} stroke="var(--border-1)" />
        <line x1={0} y1={BOTTOM} x2={W} y2={BOTTOM} stroke="var(--border-1)" />
        {ceiling != null && (
          <line
            data-part="ceiling"
            x1={0}
            y1={yFor(ceiling)}
            x2={W}
            y2={yFor(ceiling)}
            stroke="var(--ink)"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {meters.map((m, i) => (
          <polyline
            key={m.id}
            data-part="band"
            points={bandPoints(m.readings, x, start, end)}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            strokeDasharray={DASH[i % DASH.length]}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {runs.map((r) => {
          const t = toMs(r.t);
          if (t == null || t < start || t > end) return null;
          const tone = runStatusTone(r.status);
          const dim = processId != null && r.processId !== processId;
          return (
            <line
              key={r.runId}
              data-part="run"
              x1={x(t)}
              x2={x(t)}
              y1={124}
              y2={132}
              stroke={tone === 'error' ? toneVars('error').fill : 'var(--primary)'}
              strokeWidth={1.5}
              opacity={dim ? 0.3 : 1}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${r.processName} · ${r.status}`}</title>
            </line>
          );
        })}
      </svg>
      <div className={styles.legend}>
        {meters.map((m, i) => (
          <span key={m.id} className={styles.key}>
            <span
              className={styles.swatch}
              style={{
                borderColor: COLORS[i % COLORS.length],
                borderTopStyle: i === 0 ? 'solid' : 'dashed',
              }}
            />
            {m.title}
            {m.estimated ? ' (estimated)' : ''}
          </span>
        ))}
        {ceiling != null && (
          <span className={styles.key}>
            <span
              className={styles.swatch}
              style={{ borderColor: 'var(--ink)', borderTopStyle: 'dashed' }}
            />
            ceiling <span className="mono">{Math.round(ceiling)}%</span>
          </span>
        )}
        {runs.length > 0 && (
          <span className={styles.key}>
            <span style={{ width: 2, height: 10, background: 'var(--primary)' }} />
            runs
          </span>
        )}
      </div>
    </div>
  );
}
