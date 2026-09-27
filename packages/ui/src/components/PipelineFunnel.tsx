import type { FunnelResponse } from '@ai-switchboard/core/contract';
import { Fragment } from 'react';

import { cx } from '../lib/cx.js';
import { funnelModel } from '../lib/funnel.js';
import styles from './PipelineFunnel.module.css';
import { StatusChip } from './StatusChip.js';

export interface PipelineFunnelProps {
  funnel: FunnelResponse;
}

function Arrow() {
  return (
    <svg width="24" height="8" viewBox="0 0 24 8" aria-hidden="true">
      <path d="M0 4h20M17 1l3 3-3 3" fill="none" stroke="var(--border-4)" strokeWidth={1.2} />
    </svg>
  );
}

/**
 * The process pipeline for a window as a horizontal funnel: matched → after dedupe → batches →
 * (held / throttled at the gate) → invoked → outcomes. Bar size is proportional to the count;
 * sweeps enter the invoked stage as their own (sky) stream; outcomes split ok / error / unknown.
 */
export function PipelineFunnel({ funnel }: PipelineFunnelProps) {
  const model = funnelModel(funnel);
  const stopped = model.gate.held + model.gate.throttled;
  const summary = model.stages.map((s) => `${s.count} ${s.label}`).join(', ');
  return (
    <div
      className={styles.funnel}
      role="figure"
      aria-label={`Pipeline: ${summary}; ${stopped} held or throttled`}
    >
      {model.stages.map((stage, i) => (
        <Fragment key={stage.id}>
          {i > 0 &&
            (stage.id === 'invoked' ? (
              <div className={cx(styles.arrow, styles.gate)}>
                <StatusChip
                  tone={stopped > 0 ? 'warn' : 'off'}
                  size="sm"
                  count={stopped}
                  label="held / throttled"
                />
                <Arrow />
              </div>
            ) : (
              <div className={styles.arrow}>
                <Arrow />
              </div>
            ))}
          <div className={styles.stage} data-stage={stage.id} data-size={stage.size.toFixed(3)}>
            <div className={styles.barArea}>
              <div
                style={{
                  display: 'flex',
                  gap: 2,
                  width: '100%',
                  height: `${Math.max(stage.size * 100, stage.count > 0 ? 3 : 0)}%`,
                }}
              >
                {stage.segments.map((seg) => (
                  <div
                    key={seg.id}
                    className={styles.segment}
                    data-segment={seg.id}
                    title={`${seg.count} ${seg.label}`}
                    style={{ width: `${seg.share * 100}%`, background: seg.color }}
                  />
                ))}
              </div>
            </div>
            <div className={styles.count}>{stage.count}</div>
            <div className={styles.label}>
              {stage.segments.length > 1 ? (
                stage.segments.map((seg) => (
                  <span key={seg.id} className={styles.key}>
                    <span
                      className={styles.swatch}
                      style={{ background: seg.color }}
                      aria-hidden="true"
                    />
                    <span className="mono">{seg.count}</span> {seg.label}
                  </span>
                ))
              ) : (
                <span>{stage.label}</span>
              )}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
