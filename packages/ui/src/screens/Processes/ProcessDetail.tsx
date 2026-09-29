import type { ProcessDetail as ProcessDetailDTO, StatsWindow } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import {
  useDeleteProcess,
  useEnableProcess,
  useDestinations,
  useProcess,
  useProcessFunnel,
  useProcessStats,
  useResetBreaker,
  useRunProcess,
} from '../../api/index.js';
import { BreakerBanner } from '../../components/BreakerBanner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { PipelineFunnel } from '../../components/PipelineFunnel.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { QueryError } from '../../components/QueryError.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { enableProcessPrompt, resetBreakerPrompt } from '../shared/actionPrompts.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { WINDOW_LABEL, WINDOW_OPTIONS } from '../shared/statsWindow.js';
import { ActivityTab } from './ActivityTab.js';
import { approvalLabel } from './editorModel.js';
import { DefinitionTab } from './DefinitionTab.js';
import { DetailCharts } from './DetailCharts.js';
import {
  asDetailTab,
  cooldownEndsAt,
  deleteConsequence,
  enableConsequence,
} from './detailModel.js';
import { HistoryTab } from './HistoryTab.js';
import styles from './ProcessDetail.module.css';
import { RunsTab } from './RunsTab.js';

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
  const [window, setWindow] = useState<StatsWindow>('7d');
  const funnel = useProcessFunnel(p.id, window);
  const stats = useProcessStats(p.id, window);
  const destinations = useDestinations();
  const enable = useReasonedMutation(
    useEnableProcess(),
    (v: { id: string; enabled: boolean }) =>
      enableProcessPrompt(p.name, v.enabled, enableConsequence(p, v.enabled)),
    { successMessage: (r) => `${p.name} ${r.enabled ? 'enabled' : 'disabled'}` },
  );
  const navigate = useNavigate();
  const destination = destinations.data?.find((x) => x.id === p.document.destination.instanceId);
  const base = `/processes/${encodeURIComponent(p.id)}`;
  const sweeps = p.document.schedules.filter((s) => s.enabled).length;

  const runNow = useReasonedMutation(
    useRunProcess(),
    {
      title: `Run ${p.name} now?`,
      consequence:
        'Starts a manual run with the open batch, or an empty sweep context — it passes the same gates and budgets as any other run.',
      confirmLabel: 'Run now',
    },
    { successMessage: (r) => `Run ${r.outcome}${r.runId ? ` · ${r.runId}` : ''}` },
  );
  const remove = useReasonedMutation(
    useDeleteProcess(),
    {
      title: `Delete ${p.name}?`,
      consequence: deleteConsequence(p),
      confirmLabel: `Delete ${p.name}`,
      danger: true,
    },
    { successMessage: `${p.name} deleted` },
  );
  const reset = useReasonedMutation(useResetBreaker(), resetBreakerPrompt(p.name), {
    successMessage: 'Breaker reset',
  });

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
        actions={
          <>
            <LinkButton to={`${base}/edit`} variant="outline" icon="edit">
              Edit
            </LinkButton>
            <Button
              variant="primary"
              icon="play"
              requires="operator"
              loading={runNow.pending}
              disabled={!p.enabled}
              disabledReason="Enable the process to run it"
              onClick={() => {
                void runNow.run({ id: p.id });
              }}
            >
              Run now
            </Button>
            <Button
              variant="danger-outline"
              icon="trash"
              requires="operator"
              loading={remove.pending}
              onClick={() => {
                // `run` resolves null when cancelled or refused; a 204 resolves undefined.
                void remove.run({ id: p.id }).then((r) => {
                  if (r !== null) void navigate('/processes');
                });
              }}
            >
              Delete
            </Button>
            <Toggle
              boxed
              label="Enabled"
              value={p.enabled}
              requires="operator"
              onChange={(next) => void enable.run({ id: p.id, enabled: next })}
            />
          </>
        }
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
              loading={reset.pending}
              onClick={() => {
                void reset.run({ id: p.id });
              }}
            >
              Reset breaker
            </Button>
          }
        />
      )}

      <Card
        title={`Pipeline · ${WINDOW_LABEL[window]}`}
        subtitle="events flow left to right; sweeps enter at the gate as their own stream"
        actions={
          <SegmentedControl
            label="Window"
            variant="window"
            options={WINDOW_OPTIONS}
            value={window}
            onChange={setWindow}
          />
        }
      >
        {funnel.isError ? (
          <QueryError query={funnel} title="The funnel could not load" />
        ) : funnel.data ? (
          <PipelineFunnel funnel={funnel.data} />
        ) : (
          <Skeleton height={160} label="Loading the funnel" />
        )}
      </Card>

      <DetailCharts stats={stats.data} window={window} loading={stats.isPending} />

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
