import type { ProcessSummary } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { CapacityBar } from '../../components/CapacityBar.js';
import { PipelineDots } from '../../components/PipelineDots.js';
import { Sparkline } from '../../components/Sparkline.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { cx } from '../../lib/cx.js';
import styles from './Processes.module.css';
import { flowLine } from './processList.js';

export function ProcessCard({ process: p }: { process: ProcessSummary }) {
  const full = p.dailyCap.limit != null && p.dailyCap.used >= p.dailyCap.limit;
  return (
    <Link
      to={`/processes/${encodeURIComponent(p.id)}`}
      className={cx(
        styles.card,
        p.status.tone === 'error' && styles.cardError,
        p.status.tone === 'warn' && styles.cardWarn,
        !p.enabled && styles.cardOff,
      )}
      aria-label={`${p.name} · ${p.status.label}`}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{p.name}</span>
        <span className={styles.grow} />
        <StatusChip tone={p.status.tone} label={p.status.label} size="sm" />
      </div>
      <div className={styles.cardRow}>
        <PipelineDots dots={p.dots} size="lg" />
        <span className={styles.grow} />
        <span className={styles.muted}>
          {p.nextSweepAt ? (
            <>
              sweep <Time value={p.nextSweepAt} format="when" />
            </>
          ) : (
            'no sweep'
          )}
        </span>
      </div>
      <div className={styles.cardFlow}>
        <span className={styles.flow}>{flowLine(p)}</span>
        <Sparkline values={p.sparkline} label="Runs per day, last 7 days" />
      </div>
      <CapacityBar
        used={p.dailyCap.used}
        limit={p.dailyCap.limit}
        label="Runs today against the daily cap"
        overColor="var(--st-warn)"
        marks={full ? [{ at: 0, label: 'cap reached', color: 'transparent' }] : []}
      />
    </Link>
  );
}
