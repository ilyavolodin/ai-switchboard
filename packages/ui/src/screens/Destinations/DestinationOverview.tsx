import type {
  DestinationDetail,
  StatsWindow,
  UsageHistoryResponse,
} from '@ai-switchboard/core/contract';
import { DEFAULT_METER_POLL_SECONDS } from '@ai-switchboard/core/domain';
import { useState } from 'react';

import { useDestinationMeters, useDestinationUsage } from '../../api/index.js';
import { BarChart } from '../../components/BarChart.js';
import { Card } from '../../components/Card.js';
import { MeterBand } from '../../components/MeterBand.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { seriesColor } from '../../lib/colors.js';
import { formatCount, formatUsage, toMs } from '../../lib/format.js';
import styles from '../shared/detail.module.css';
import { WINDOW_LABEL, WINDOW_OPTIONS } from '../shared/statsWindow.js';
import { dayLabel, runProcesses, runStatusSeries } from './destinationModel.js';

export function DestinationOverview({ destination }: { destination: DestinationDetail }) {
  const [range, setRange] = useState<StatsWindow>('7d');
  const [processId, setProcessId] = useState('');
  const meters = useDestinationMeters(destination.id, range);
  const usage = useDestinationUsage(destination.id, range);
  const label = WINDOW_LABEL[range];
  const lastRead = destination.meters
    .map((m) => m.observedAt)
    .filter((t): t is string => t != null)
    .sort((a, b) => (toMs(b) ?? 0) - (toMs(a) ?? 0))[0];
  const processes = runProcesses(meters.data?.runs ?? []);

  return (
    <>
      <div className={styles.toolbar}>
        <span className="t-section-title">Capacity and usage</span>
        <span className={styles.grow} />
        <SegmentedControl
          variant="window"
          label="Stats window"
          options={WINDOW_OPTIONS}
          value={range}
          onChange={setRange}
        />
      </div>

      {destination.meters.length > 0 && (
        <Card
          title="Meters"
          meta={
            <span className="t-caption">
              read every{' '}
              <span className="mono">
                {destination.caps.meterPollSeconds ?? DEFAULT_METER_POLL_SECONDS}
              </span>{' '}
              s · last <Time value={lastRead ?? null} fallback="never" />
            </span>
          }
        >
          <div className={styles.gauges} role="list" aria-label="Meters now">
            {destination.meters.map((m) => (
              <span role="listitem" key={m.meterId}>
                <MeterGauge meter={m} size="lg" showSweepCeilings />
              </span>
            ))}
          </div>
        </Card>
      )}

      {destination.meterSpecs.length > 0 && (
        <Card
          title={`Meter history · ${label}`}
          subtitle="Tick marks are runs, so you can see which process pushed a window."
          actions={
            processes.length > 0 ? (
              <Select
                size="sm"
                className={styles.toolbarSelect}
                aria-label="Highlight a process"
                options={[
                  { value: '', label: 'All processes' },
                  ...processes.map((p) => ({ value: p.id, label: p.name })),
                ]}
                value={processId}
                onChange={(e) => {
                  setProcessId(e.target.value);
                }}
              />
            ) : undefined
          }
        >
          <QueryBoundary
            query={meters}
            errorTitle="Meter history could not load"
            pending={<Skeleton height={160} label="Loading meter history" />}
            empty={<span className={styles.caption}>No readings in this window.</span>}
            isEmpty={(d) => d.meters.length === 0}
          >
            {(d) => (
              <MeterBand
                meters={d.meters}
                runs={d.runs}
                processId={processId || undefined}
                ariaLabel={`Meter history over ${label} with ${d.runs.length} run markers`}
              />
            )}
          </QueryBoundary>
        </Card>
      )}

      <QueryBoundary
        query={usage}
        errorTitle="Usage could not load"
        pending={<Skeleton shape="card" height={200} label="Loading usage" />}
      >
        {(data) => <UsageCards usage={data} label={label} />}
      </QueryBoundary>
    </>
  );
}

function UsageCards({ usage, label }: { usage: UsageHistoryResponse; label: string }) {
  return (
    <div className={styles.threeUp}>
      {usage.dimensions.map((d, i) => {
        const total = d.days.reduce((s, x) => s + x.value, 0);
        return (
          <Card
            key={d.id}
            title={d.title}
            subtitle={`${d.unit} · per day`}
            meta={<span className="mono">{formatUsage(total, d.unit)}</span>}
          >
            <BarChart
              labels={d.days.map((x) => dayLabel(x.day))}
              series={[
                {
                  id: d.id,
                  label: d.title,
                  color: seriesColor(i),
                  values: d.days.map((x) => x.value),
                },
              ]}
              height={110}
              labelEvery={d.days.length > 10 ? 5 : 1}
              ariaLabel={`${d.title} per day over ${label}, in ${d.unit}`}
              formatValue={(v) => formatUsage(v, d.unit)}
            />
          </Card>
        );
      })}
      <RunsByStatus usage={usage} label={label} />
    </div>
  );
}

function RunsByStatus({ usage, label }: { usage: UsageHistoryResponse; label: string }) {
  const series = runStatusSeries(usage);
  const totals = series.map((s) => ({ ...s, total: s.values.reduce((a, b) => a + b, 0) }));
  const all = totals.reduce((s, t) => s + t.total, 0);
  return (
    <Card
      title={`Runs by status · ${label}`}
      meta={<span className="mono">{formatCount(all)}</span>}
    >
      {all === 0 ? (
        <span className={styles.caption}>No runs in this window.</span>
      ) : (
        <>
          <div
            className={styles.statusBar}
            role="img"
            aria-label={`Runs by status: ${totals.map((t) => `${t.total} ${t.id}`).join(', ')}`}
          >
            {totals.map((t) => (
              <span
                key={t.id}
                title={`${t.label} ${t.total}`}
                style={{ width: `${(t.total / all) * 100}%`, background: t.color }}
              />
            ))}
          </div>
          <div className={styles.statusLegend}>
            {totals.map((t) => (
              <span key={t.id}>
                <span className={styles.dot} style={{ background: t.color }} />
                <span className="mono">{t.total}</span> {t.label}
              </span>
            ))}
          </div>
          <BarChart
            stacked
            showLegend={false}
            labels={usage.runsByStatus.map((d) => dayLabel(d.day))}
            series={series}
            height={110}
            labelEvery={usage.runsByStatus.length > 10 ? 5 : 1}
            ariaLabel={`Runs per day by status over ${label}`}
          />
        </>
      )}
    </Card>
  );
}
