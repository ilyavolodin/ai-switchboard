import type { StageIndicator as StageIndicatorDTO } from '@ai-switchboard/core/contract';
import { Fragment } from 'react';

import { cx } from '../lib/cx.js';
import { STAGE_STOPS } from '../lib/pipeline.js';
import { toneVars } from '../lib/tone.js';
import styles from './StageIndicator.module.css';

export interface StageIndicatorProps {
  indicator: StageIndicatorDTO;
  showLabel?: boolean;
  compact?: boolean;
}

export function StageIndicator({ indicator, showLabel = true, compact }: StageIndicatorProps) {
  const { reached, tone, label } = indicator;
  const where = reached > 0 ? STAGE_STOPS[reached - 1] : 'not received';
  return (
    <span className={cx(styles.wrap, compact && styles.compact)}>
      <span
        className={styles.stops}
        role="img"
        aria-label={`${label} · reached ${where ?? ''} (${reached} of 5)`}
      >
        {STAGE_STOPS.map((stop, i) => {
          const state = i < reached - 1 ? 'passed' : i === reached - 1 ? 'current' : 'pending';
          return (
            <Fragment key={stop}>
              {i > 0 && (
                <span
                  className={cx(styles.link, i < reached && styles.linkPassed)}
                  aria-hidden="true"
                />
              )}
              <span
                data-stop={stop}
                data-state={state}
                className={cx(
                  styles.stop,
                  state === 'passed' && styles.passed,
                  state === 'pending' && styles.pending,
                )}
                style={state === 'current' ? { background: toneVars(tone).fill } : undefined}
              />
            </Fragment>
          );
        })}
      </span>
      {showLabel && <span className={styles.label}>{label}</span>}
    </span>
  );
}
