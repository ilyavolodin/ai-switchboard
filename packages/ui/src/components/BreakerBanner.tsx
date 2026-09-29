import type { RunSummary } from '@ai-switchboard/core/contract';
import { Fragment, type ReactNode } from 'react';

import { formatClock, toMs } from '../lib/format.js';
import { Banner } from './Banner.js';
import styles from './BreakerBanner.module.css';
import { Countdown } from './Countdown.js';

export interface BreakerBannerProps {
  openedAt: string | null;
  /** Any order; drawn by time. */
  failures: RunSummary[];
  cooldownEndsAt?: string | null;
  note?: ReactNode;
  action?: ReactNode;
}

export function BreakerBanner({
  openedAt,
  failures,
  cooldownEndsAt,
  note,
  action,
}: BreakerBannerProps) {
  const sorted = [...failures].sort((a, b) => (toMs(a.invokedAt) ?? 0) - (toMs(b.invokedAt) ?? 0));
  return (
    <Banner tone="error" size="lg" title="Breaker open" actions={action}>
      {sorted.length} failed run{sorted.length === 1 ? '' : 's'}
      {openedAt ? (
        <>
          {' '}
          · opened <span className="mono">{formatClock(toMs(openedAt) ?? 0)}</span>
        </>
      ) : null}
      . Event runs are refused
      {cooldownEndsAt ? (
        <>
          {' '}
          <Countdown until={cooldownEndsAt} prefix="for" />
        </>
      ) : null}
      {note ? <>; {note}</> : null}.{' '}
      <span className={styles.timeline} aria-label="Failed runs">
        {sorted.map((r, i) => (
          <Fragment key={r.id}>
            {i > 0 && <span className={styles.link} aria-hidden="true" />}
            <span className={styles.dot} aria-hidden="true" />
            <span title={r.statusReason ?? r.statusLabel.label}>
              {formatClock(toMs(r.invokedAt) ?? 0)}
            </span>
          </Fragment>
        ))}
      </span>
    </Banner>
  );
}
