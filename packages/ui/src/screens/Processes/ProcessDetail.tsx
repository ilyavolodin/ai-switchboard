import type { ProcessDetail as ProcessDetailDTO, StatsWindow } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import { useProcess, useProcessFunnel, useProcessStats } from '../../api/index.js';
import { BreakerBanner } from '../../components/BreakerBanner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { PageHeader } from '../../components/PageHeader.js';
import { PipelineFunnel } from '../../components/PipelineFunnel.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { WINDOW_LABEL, WINDOW_OPTIONS } from '../shared/statsWindow.js';
import { ActivityTab } from './ActivityTab.js';
import { approvalLabel } from './editorModel.js';
import { DefinitionTab } from './DefinitionTab.js';
import { DetailCharts } from './DetailCharts.js';
import { asDetailTab, cooldownEndsAt } from './detailModel.js';
import { HistoryTab } from './HistoryTab.js';
import styles from './ProcessDetail.module.css';
import { ProcessHeaderActions } from './ProcessHeaderActions.js';
import { RunsTab } from './RunsTab.js';
import { useEditorLookups } from './useEditorLookups.js';
import { useProcessActions } from './useProcessActions.js';

export function ProcessDetail() {
  const { id = '', tab } = useParams();
  const process = useProcess(id);
  const current = asDetailTab(tab);

  if (current == null) return <UnknownTab to={`/processes/${encodeURIComponent(id)}`} />;
  if (process.isPending) {
    return (
      <>
        <Skeleton height={32} width={280} label="Loading the process" />
        <Skeleton shape="card" height={220} />
      </>
    );
  }
  if (process.isError) {
    return (
      <LoadFailure
        error={process.error}
        noun="process"
        listTo="/processes"
        listLabel="All processes"
      />
    );
  }
  return <Detail process={process.data} tab={current} />;
}

function Detail({
  process: p,
  tab,
}: {
  process: ProcessDetailDTO;
  tab: NonNullable<ReturnType<typeof asDetailTab>>;
}) {
  const [statsWindow, setStatsWindow] = useState<StatsWindow>('7d');
  const funnel = useProcessFunnel(p.id, statsWindow);
  const stats = useProcessStats(p.id, statsWindow);
  const names = useEditorLookups();
  const actions = useProcessActions(p);
  const destination = names.destinationSummary(p.document.destination.instanceId);
  const base = `/processes/${encodeURIComponent(p.id)}`;
  const sweeps = p.document.schedules.filter((s) => s.enabled).length;

  return (
    <>
      <PageHeader
        size="lg"
        title={p.name}
        back={{ to: '/processes', label: 'Back to all processes' }}
        meta={
          <span className={styles.meta}>
            <StatusChip tone={p.status.tone} label={p.status.label} />
            {p.awaitingApproval > 0 && (
              <StatusChip
                tone="warn"
                count={p.awaitingApproval}
                label="awaiting approval"
                size="sm"
              />
            )}
            <span className={styles.metaText} title="approval gate">
              approval {approvalLabel(p.document.gates.approval)}
            </span>
            <span className={styles.metaText}>
              breaker {p.breakerState}
              {p.breakerState === 'closed' &&
                ` · opens after ${p.document.gates.breaker.threshold} failures`}
            </span>
            <span className={styles.metaText}>
              {p.nextSweepAt ? (
                <>
                  next sweep <Time value={p.nextSweepAt} format="when" />
                </>
              ) : (
                'no sweep'
              )}
            </span>
            {destination && <span className={styles.metaText}>→ {destination.name}</span>}
          </span>
        }
        description={p.document.description || undefined}
        actions={<ProcessHeaderActions processId={p.id} enabled={p.enabled} actions={actions} />}
      />

      {p.breakerState === 'open' && (
        <BreakerBanner
          openedAt={p.breakerOpenedAt}
          failures={p.recentFailures}
          cooldownEndsAt={cooldownEndsAt(p)}
          note={sweeps > 0 ? 'sweeps still run' : undefined}
          action={
            <Button
              variant="danger"
              size="sm"
              requires="operator"
              loading={actions.resetBreaker.pending}
              onClick={actions.resetBreaker.run}
            >
              Reset breaker
            </Button>
          }
        />
      )}

      <Card
        title={`Pipeline · ${WINDOW_LABEL[statsWindow]}`}
        subtitle="events flow left to right; sweeps enter at the gate as their own stream"
        actions={
          <SegmentedControl
            label="Window"
            variant="window"
            options={WINDOW_OPTIONS}
            value={statsWindow}
            onChange={setStatsWindow}
          />
        }
      >
        <QueryBoundary
          query={funnel}
          errorTitle="The funnel could not load"
          pending={<Skeleton height={160} label="Loading the funnel" />}
        >
          {(data) => <PipelineFunnel funnel={data} />}
        </QueryBoundary>
      </Card>

      <DetailCharts stats={stats} window={statsWindow} />

      <RoutedTabs
        label="Process sections"
        items={[
          { to: base, label: 'Activity', end: true },
          { to: `${base}/runs`, label: 'Runs' },
          { to: `${base}/definition`, label: 'Definition' },
          { to: `${base}/history`, label: 'History', count: p.version },
        ]}
      />

      {tab === 'activity' && <ActivityTab processId={p.id} />}
      {tab === 'runs' && <RunsTab processId={p.id} />}
      {tab === 'definition' && <DefinitionTab processId={p.id} doc={p.document} />}
      {tab === 'history' && (
        <HistoryTab processId={p.id} processName={p.name} currentVersion={p.version} />
      )}
    </>
  );
}
