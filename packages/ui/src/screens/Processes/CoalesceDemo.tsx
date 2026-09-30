import type { ProcessDocument } from '@ai-switchboard/core/contract';
import { coalesceArrivals } from '@ai-switchboard/core/domain';

import { useReducedMotion } from '../../hooks/useReducedMotion.js';
import { cx } from '../../lib/cx.js';
import styles from './ProcessEditor.module.css';

/** Seconds after the first event, the same for every setting. */
const ARRIVALS = [0, 25, 50, 70, 190, 205, 400, 430, 450, 470];
const COLORS = ['var(--primary)', 'var(--sky)', 'var(--teal)', 'var(--berry)'];
const W = 560;
const H = 64;

export function CoalesceDemo({ batching }: { batching: ProcessDocument['batching'] }) {
  const reduced = useReducedMotion();
  const batches = coalesceArrivals(ARRIVALS, batching);
  const end =
    Math.max(ARRIVALS[ARRIVALS.length - 1] ?? 0, ...batches.map((b) => b.closesAt)) * 1.04 + 10;
  const x = (t: number) => 12 + (t / end) * (W - 24);
  const batchOf = (i: number) => batches.findIndex((b) => b.events.includes(i));
  const key = `${batching.debounceSeconds}-${batching.maxSize}-${batching.maxAgeSeconds}`;
  const why = { debounce: 'debounce', size: 'max size', age: 'max age' } as const;

  return (
    <figure className={styles.coalesce}>
      <svg
        key={key}
        viewBox={`0 0 ${W} ${H}`}
        className={cx(styles.coalesceSvg, !reduced && styles.animated)}
        role="img"
        aria-label={`${ARRIVALS.length} events become ${batches.length} run${batches.length === 1 ? '' : 's'}: ${batches
          .map((b) => `${b.events.length} closed by ${why[b.reason]}`)
          .join(', ')}`}
      >
        <line x1={12} y1={44} x2={W - 12} y2={44} stroke="var(--line)" strokeWidth={2} />
        {batches.map((b, i) => {
          const first = ARRIVALS[b.events[0] ?? 0] ?? 0;
          const color = COLORS[i % COLORS.length];
          return (
            <g
              key={i}
              data-part="batch"
              style={{ animationDelay: `${(b.closesAt / end) * 2.4}s` }}
              className={styles.batchMark}
            >
              <path
                d={`M${x(first)} 54 V58 H${x(b.closesAt)} V54`}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
              />
              <rect x={x(b.closesAt) - 3} y={36} width={6} height={16} rx={2} fill={color} />
            </g>
          );
        })}
        {ARRIVALS.map((t, i) => (
          <circle
            key={i}
            data-part="event"
            cx={x(t)}
            cy={44}
            r={4.5}
            fill={COLORS[batchOf(i) % COLORS.length]}
            className={styles.eventDot}
            style={{ animationDelay: `${(t / end) * 2.4}s` }}
          />
        ))}
      </svg>
      <figcaption className="t-caption">
        {ARRIVALS.length} events → {batches.length} run{batches.length === 1 ? '' : 's'} at debounce{' '}
        {batching.debounceSeconds} s, max {batching.maxSize}. Each join restarts the debounce; the
        bar marks where a batch closes and a run starts.
      </figcaption>
    </figure>
  );
}
