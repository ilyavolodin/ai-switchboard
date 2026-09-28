import type { ProcessDetail as ProcessDetailDTO, StatsWindow } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import {
  useDeleteProcess,
  useEnableProcess,
  useExecutors,
  useProcess,
  useProcessFunnel,
  useProcessStats,
  useResetBreaker,
  useRunProcess,
} from '../../api/index.js';
import { NotFound } from '../../app/NotFound.js';
import { Banner } from '../../components/Banner.js';
import { BreakerBanner } from '../../components/BreakerBanner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { PipelineFunnel } from '../../components/PipelineFunnel.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import { ActivityTab } from './ActivityTab.js';
import { DefinitionTab } from './DefinitionTab.js';
import { DetailCharts } from './DetailCharts.js';
import {
  asDetailTab,
  cooldownEndsAt,
  deleteConsequence,
  enableConsequence,
  WINDOWS,
  windowLabel,
} from './detailModel.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { HistoryTab } from './HistoryTab.js';
import styles from './ProcessDetail.module.css';
import { RunsTab } from './RunsTab.js';

/**
 * A process (`/processes/:id`, `/processes/:id/:tab`): the header (status, enabled toggle with a
 * confirm naming what stops, breaker, next sweep, Run now), the pipeline funnel and three small
 * charts for a selectable window, and the Activity · Runs · Definition · History tabs.
 */
export function ProcessDetail() {
  const { id = '', tab } = useParams();
  const process = useProcess(id);
  const current = asDetailTab(tab);

  if (current == null) return <NotFound />;
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
  const toast = useToast();
  const [window, setWindow] = useState<StatsWindow>('7d');
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const funnel = useProcessFunnel(p.id, window);
  const stats = useProcessStats(p.id, window);
  const executors = useExecutors();
  const enable = useEnableProcess();
  const navigate = useNavigate();
  const executor = executors.data?.find((x) => x.id === p.document.executor.instanceId);
  const base = `/processes/${encodeURIComponent(p.id)}`;
  const approval = p.document.gates.approval;
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
  const reset = useReasonedMutation(
    useResetBreaker(),
    {
      title: `Reset the ${p.name} breaker?`,
      consequence: 'Event runs resume immediately; the failure count starts again from zero.',
      confirmLabel: 'Reset breaker',
    },
    { successMessage: 'Breaker reset' },
  );

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
              approval {approval === 'none' || approval === 'always' ? approval : 'by expression'}
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
            {executor && <span className={styles.metaText}>→ {executor.name}</span>}
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
              checked={p.enabled}
              requires="operator"
              onChange={(next) => {
                setConfirm(next);
              }}
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
        title={`Pipeline · ${windowLabel(window)}`}
        subtitle="events flow left to right; sweeps enter at the gate as their own stream"
        actions={
          <SegmentedControl
            label="Window"
            variant="window"
            options={WINDOWS}
            value={window}
            onChange={setWindow}
          />
        }
      >
        {funnel.isError ? (
          <Banner tone="error" title="Could not load the funnel">
            {errorMessage(funnel.error)}
          </Banner>
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

      <ConfirmDialog
        open={confirm != null}
        title={confirm ? `Enable ${p.name}?` : `Disable ${p.name}?`}
        consequence={enableConsequence(p, confirm ?? false)}
        confirmLabel={confirm ? `Enable ${p.name}` : `Disable ${p.name}`}
        danger={confirm === false}
        busy={enable.isPending}
        onCancel={() => {
          setConfirm(null);
        }}
        onConfirm={(reason) => {
          const enabled = confirm ?? false;
          enable
            .mutateAsync({ id: p.id, enabled, reason })
            .then(() => {
              toast({ tone: 'ok', title: `${p.name} ${enabled ? 'enabled' : 'disabled'}` });
            })
            .catch((e: unknown) => {
              toast({ tone: 'error', title: 'That did not work', detail: errorMessage(e) });
            })
            .finally(() => {
              setConfirm(null);
            });
        }}
      />
    </>
  );
}
