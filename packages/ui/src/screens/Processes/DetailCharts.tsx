import type { ProcessStatsResponse, StatsWindow } from '@ai-switchboard/core/contract';

import { BarChart } from '../../components/BarChart.js';
import { Card } from '../../components/Card.js';
import { Skeleton } from '../../components/Skeleton.js';
import { formatSeconds, formatUsage } from '../../lib/format.js';
import { dayLabel, windowLabel } from './detailModel.js';
import styles from './ProcessDetail.module.css';

/**
 * The three small charts under the funnel: runs and throttles per day, latency and duration
 * medians, and usage per run for each dimension the executor reports.
 */
export function DetailCharts({
  stats,
  window,
  loading,
}: {
  stats: ProcessStatsResponse | undefined;
  window: StatsWindow;
  loading: boolean;
}) {
  if (loading || !stats) {
    return (
      <div className={styles.charts}>
        {[0, 1, 2].map((i) => (
          <Skeleton
            key={i}
            shape="card"
            height={180}
            label={i === 0 ? 'Loading charts' : undefined}
          />
        ))}
      </div>
    );
  }
  const labels = stats.days.map((d) => dayLabel(d.day, window));
  const every = window === '30d' ? 5 : 1;
  const failed = (r: ProcessStatsResponse['days'][number]['runs']) =>
    (r.error ?? 0) + (r.failed ?? 0) + (r.unknown ?? 0);
  return (
    <div className={styles.charts}>
      <Card title="Runs and throttles per day" meta={windowLabel(window)}>
        <BarChart
          ariaLabel="Runs and throttles per day"
          labels={labels}
          labelEvery={every}
          stacked
          series={[
            {
              id: 'ok',
              label: 'ok',
              color: 'var(--st-ok)',
              values: stats.days.map((d) => d.runs.ok ?? 0),
            },
            {
              id: 'error',
              label: 'error',
              color: 'var(--st-err)',
              values: stats.days.map((d) => failed(d.runs)),
            },
            {
              id: 'throttled',
              label: 'throttled or held',
              color: 'var(--st-warn)',
              values: stats.days.map((d) => d.throttled + d.held),
            },
          ]}
        />
      </Card>
      <Card title="Latency and duration, p50" meta={windowLabel(window)}>
        <BarChart
          ariaLabel="Median latency and run duration per day"
          labels={labels}
          labelEvery={every}
          formatValue={formatSeconds}
          series={[
            {
              id: 'latency',
              label: 'batch close → invoke',
              color: 'var(--sky)',
              values: stats.days.map((d) => d.latencyP50Seconds ?? 0),
            },
            {
              id: 'duration',
              label: 'run duration',
              color: 'var(--primary)',
              values: stats.days.map((d) => d.durationP50Seconds ?? 0),
            },
          ]}
        />
      </Card>
      <Card title="Usage per run" meta={windowLabel(window)}>
        {stats.usagePerRun.length === 0 ? (
          <p className="t-caption">The executor reports no usage for these runs.</p>
        ) : (
          <ul className={styles.usage} aria-label="Usage per run">
            {stats.usagePerRun.map((u) => {
              const max = Math.max(
                ...stats.usagePerRun.filter((x) => x.unit === u.unit).map((x) => x.average ?? 0),
                1,
              );
              return (
                <li key={u.dimension} className={styles.usageRow}>
                  <span className={styles.usageTitle}>{u.title}</span>
                  <span className={styles.usageBar} aria-hidden="true">
                    <span style={{ width: `${((u.average ?? 0) / max) * 100}%` }} />
                  </span>
                  <span className={styles.usageValue}>
                    {u.average != null ? formatUsage(u.average, u.unit) : '—'} avg
                  </span>
                  <span className="t-caption">{formatUsage(u.total, u.unit)} total</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
