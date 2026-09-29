import type { SourceDetail, StatsWindow } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { Link } from 'react-router';

import { useSourceStats } from '../../api/index.js';
import { BarChart } from '../../components/BarChart.js';
import { Card } from '../../components/Card.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { QueryError } from '../../components/QueryError.js';
import { formatCount } from '../../lib/format.js';
import styles from '../shared/detail.module.css';
import { WINDOW_LABEL, WINDOW_OPTIONS } from '../shared/statsWindow.js';
import { stageSeries, statBuckets, typeSeries, typeSplit } from './sourceModel.js';

export function SourceOverview({ source }: { source: SourceDetail }) {
  const [range, setRange] = useState<StatsWindow>('24h');
  const stats = useSourceStats(source.id, range);
  const unit = range === '24h' ? 'hour' : 'day';
  const label = WINDOW_LABEL[range];
  const { parts } = typeSplit(source);

  const buckets = stats.data ? statBuckets(stats.data, range) : [];
  const labels = buckets.map((b) => b.label);
  const failures = stats.data?.verifyFailures ?? [];
  const failureTotal = failures.reduce((s, f) => s + f.count, 0);

  return (
    <>
      <div className={styles.toolbar}>
        <span className="t-section-title">Traffic</span>
        <span className={styles.grow} />
        <SegmentedControl
          variant="window"
          label="Stats window"
          options={WINDOW_OPTIONS}
          value={range}
          onChange={setRange}
        />
      </div>
      <div className={styles.twoUp}>
        {stats.isPending ? (
          <Skeleton shape="card" height={360} label="Loading source stats" />
        ) : stats.isError ? (
          <QueryError query={stats} title="Stats could not load" />
        ) : (
          <>
            <Card title={`Events per ${unit} by type · ${label}`}>
              <BarChart
                stacked
                labels={labels}
                series={typeSeries(buckets)}
                labelEvery={range === '24h' ? 3 : range === '30d' ? 5 : 1}
                ariaLabel={`Events per ${unit} by type over ${label}`}
                formatValue={formatCount}
              />
            </Card>
            <Card title={`Events per ${unit} by stage · ${label}`}>
              <BarChart
                stacked
                labels={labels}
                series={stageSeries(buckets)}
                labelEvery={range === '24h' ? 3 : range === '30d' ? 5 : 1}
                ariaLabel={`Events per ${unit} by pipeline stage over ${label}`}
                formatValue={formatCount}
              />
            </Card>
          </>
        )}
      </div>
      <div className={styles.threeUp}>
        <Card title="By type · 24 h">
          {parts.length === 0 ? (
            <span className={styles.caption}>No events in the last 24 h.</span>
          ) : (
            <ul className={styles.list}>
              {parts.map((p) => (
                <li key={p.type} className={styles.listRow}>
                  <span className={styles.dot} style={{ background: p.color }} />
                  <span className={`${styles.grow} mono`}>{p.type}</span>
                  <span className={styles.count}>{formatCount(p.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Processes it feeds"
          meta={<span className="mono">{source.processes.length}</span>}
        >
          {source.processes.length === 0 ? (
            <span className={styles.caption}>
              No process has a trigger on this source yet. Add one in the process editor.
            </span>
          ) : (
            <ul className={styles.list}>
              {source.processes.map((p) => (
                <li key={p.id} className={styles.listRow}>
                  <Link to={`/processes/${p.id}`} className={styles.grow}>
                    {p.name}
                  </Link>
                  <span className="mono t-caption">{p.eventTypes.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Verify failures"
          meta={
            <span>
              <span className="mono">{failureTotal}</span> · {label}
            </span>
          }
        >
          {failures.length === 0 ? (
            <span className={styles.caption}>
              None in this window.
              {source.lastVerifyFailureAt && (
                <>
                  {' '}
                  Last one <Time value={source.lastVerifyFailureAt} />.
                </>
              )}
            </span>
          ) : (
            <ul className={styles.list} aria-label="Verify failures by hour">
              {failures.map((f) => (
                <li key={f.hour} className={styles.listRow}>
                  <Time value={f.hour} format="when" />
                  <span className={styles.grow} />
                  <span className={styles.count}>{f.count}</span> rejected
                </li>
              ))}
            </ul>
          )}
          <span className={styles.caption}>
            Rejected with an empty 401 before any process saw them. Bodies are not stored.
          </span>
        </Card>
      </div>
    </>
  );
}
