import type { DestinationDetail, StatsWindow } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useDestinationMeters, useDestinationUsage } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { BarChart } from '../../components/BarChart.js';
import { Card } from '../../components/Card.js';
import { MeterBand } from '../../components/MeterBand.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { formatCount, formatUsage, toMs } from '../../lib/format.js';
import { seriesColor } from '../../lib/instances.js';
import styles from '../Sources/detail.module.css';
import { WINDOW_LABEL, WINDOW_OPTIONS } from '../Sources/sourceModel.js';
import {
  DEFAULT_METER_POLL_SECONDS,
  dayLabel,
  runProcesses,
  runStatusSeries,
} from './destinationModel.js';

/**
 * The destination's Overview tab: its meters now (large arcs), meter history as bands with run
 * markers (highlight one process to see which one pushed a window), usage per day as one chart
 * per declared dimension with its unit, and runs by status.
 */
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
          {meters.isPending ? (
            <Skeleton height={160} label="Loading meter history" />
          ) : meters.isError ? (
            <Banner tone="error" title="Meter history could not load">
              {errorMessage(meters.error)}
            </Banner>
          ) : meters.data.meters.length === 0 ? (
            <span className={styles.caption}>No readings in this window.</span>
          ) : (
            <MeterBand
              meters={meters.data.meters}
              runs={meters.data.runs}
              processId={processId || undefined}
              ariaLabel={`Meter history over ${label} with ${meters.data.runs.length} run markers`}
            />
          )}
        </Card>
      )}

      {usage.isPending ? (
        <Skeleton shape="card" height={200} label="Loading usage" />
      ) : usage.isError ? (
        <Banner tone="error" title="Usage could not load">
          {errorMessage(usage.error)}
        </Banner>
      ) : (
        <div className={styles.threeUp}>
          {usage.data.dimensions.map((d, i) => {
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
          <RunsByStatus usage={usage.data} label={label} />
        </div>
      )}
    </>
  );
}

function RunsByStatus({
  usage,
  label,
}: {
  usage: NonNullable<ReturnType<typeof useDestinationUsage>['data']>;
  label: string;
}) {
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
