import type { MeterGaugeDTO } from '@ai-switchboard/core/contract';
import { Link } from 'react-router';

import { Countdown } from '../components/Countdown.js';
import { MeterGauge } from '../components/MeterGauge.js';
import { useNow } from '../hooks/useNow.js';
import { cx } from '../lib/cx.js';
import { formatDuration, formatRelative, toMs } from '../lib/format.js';
import {
  lowestEventCeiling,
  meterValueText,
  primaryMeters,
  shortMeterLabel,
} from '../lib/meter.js';
import styles from './CapacityStrip.module.css';

function executorShortName(name: string): string {
  const base = name.split(' — ')[0] ?? name;
  const words = base.split(/\s+/);
  return words[words.length - 1] ?? base;
}

function tooltip(m: MeterGaugeDTO, nowMs: number): string {
  const parts = [`${m.executorName} · ${m.title} ${meterValueText(m)}`];
  const c = lowestEventCeiling(m);
  if (c != null) parts.push(`ceiling ${Math.round(c)}%`);
  if (m.estimated) parts.push('estimated');
  const reset = toMs(m.resetsAt);
  if (reset != null && reset > nowMs) parts.push(`resets in ${formatDuration(reset - nowMs)}`);
  const observed = toMs(m.observedAt);
  if (m.stale)
    parts.push(
      observed != null ? `stale · last read ${formatRelative(observed, nowMs)}` : 'never read',
    );
  return parts.join(' · ');
}

/**
 * The top bar's capacity strip: one 24 px arc per executor instance's primary meter, with value
 * and reset countdown, grouped by executor, each linking to the executor.
 */
export function CapacityStrip({ meters }: { meters: MeterGaugeDTO[] }) {
  const nowMs = useNow(30_000);
  const shown = primaryMeters(meters);
  if (shown.length === 0) return null;
  return (
    <div className={styles.strip} aria-label="Executor capacity">
      {shown.map((m, i) => {
        const allowance = m.kind === 'allowance' && m.used != null && m.limit != null;
        const value = allowance
          ? `${meterValueText(m)} ${m.unit}`
          : `${shortMeterLabel(m.title)} ${meterValueText(m)}`;
        return (
          <div key={`${m.executorId}:${m.meterId}`} className={styles.group}>
            {i > 0 && <span className={styles.divider} aria-hidden="true" />}
            <span className={styles.groupLabel}>{executorShortName(m.executorName)}</span>
            <Link
              to={`/executors/${encodeURIComponent(m.executorId)}`}
              className={cx(styles.meter, m.stale && styles.stale)}
              title={tooltip(m, nowMs)}
              aria-label={tooltip(m, nowMs)}
            >
              <MeterGauge meter={m} size="sm" />
              <span>
                <span className={styles.value}>{value}</span>
                {m.resetsAt && !m.stale && (
                  <span className={styles.reset}>
                    {' · '}
                    <Countdown until={m.resetsAt} compact />
                  </span>
                )}
              </span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
