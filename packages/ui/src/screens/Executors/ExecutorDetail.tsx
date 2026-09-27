import type { ExecutorDetail as ExecutorDetailDTO } from '@ai-switchboard/core/contract';
import { useParams } from 'react-router';

import {
  useClearSoftHold,
  useEnableExecutor,
  useExecutor,
  useReadMeters,
  useReloadExecutor,
} from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Countdown } from '../../components/Countdown.js';
import { Icon } from '../../components/Icon.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { InstanceStateBanners } from '../shared/InstanceStateBanners.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { CopyButton } from '../Sources/CopyButton.js';
import styles from '../Sources/detail.module.css';
import { SecretRefsFact } from '../Sources/SecretRefsFact.js';
import { enableExecutorPrompt } from './executorModel.js';
import { ExecutorOverview } from './ExecutorOverview.js';
import { ExecutorRuns } from './ExecutorRuns.js';
import { ExecutorSettings } from './ExecutorSettings.js';

/**
 * An executor instance: header (health, tracking, Read meters now, Reload, Enabled, soft hold)
 * and the Overview / Settings / Runs tabs.
 */
export function ExecutorDetail() {
  const { id, tab } = useParams();
  const executor = useExecutor(id);

  if (executor.isPending) {
    return <Skeleton shape="card" height={320} label="Loading the executor" />;
  }
  if (executor.isError) {
    return (
      <LoadFailure
        error={executor.error}
        noun="executor"
        listTo="/executors"
        listLabel="All executors"
      />
    );
  }
  return <ExecutorView executor={executor.data} tab={tab} />;
}

function ExecutorView({ executor, tab }: { executor: ExecutorDetailDTO; tab: string | undefined }) {
  const base = `/executors/${executor.id}`;
  const vars = { id: executor.id };
  const readMeters = useReasonedMutation(
    useReadMeters(),
    {
      title: `Read the meters of ${executor.name} now?`,
      consequence:
        'Switchboard asks the backend for fresh readings now instead of waiting for the next poll.',
      confirmLabel: 'Read meters',
    },
    { successMessage: (d) => `Read ${d.length} meter${d.length === 1 ? '' : 's'}` },
  );
  const clearHold = useReasonedMutation(
    useClearSoftHold(),
    {
      title: `Clear the soft hold on ${executor.name}?`,
      consequence:
        'Runs may start on it again right away, before the backend said it was ready. Held batches go on the next sweep.',
      confirmLabel: 'Clear soft hold',
      danger: true,
    },
    { successMessage: 'Soft hold cleared' },
  );
  const reload = useReasonedMutation(
    useReloadExecutor(),
    {
      title: `Reload ${executor.name}?`,
      consequence:
        'The live plugin object is re-created from the saved settings and secrets are resolved again.',
      confirmLabel: 'Reload',
    },
    { successMessage: 'Executor reloaded' },
  );
  const enable = useReasonedMutation(useEnableExecutor(), (v: { id: string; enabled: boolean }) =>
    enableExecutorPrompt(executor, v.enabled),
  );

  return (
    <>
      <PageHeader
        title={executor.name}
        back={{ to: '/executors', label: 'Back to executors' }}
        meta={
          <>
            <StatusChip tone={executor.status.tone} label={executor.status.label} />
            {executor.softHoldUntil && <StatusChip tone="warn" label="soft hold" />}
            <span className="t-caption">
              <span className="mono">{executor.typeId}</span> · {executor.tracking} tracking ·{' '}
              {executor.idempotentInvoke ? 'idempotent' : 'not idempotent'}
            </span>
          </>
        }
        actions={
          <>
            {executor.meterSpecs.length > 0 && (
              <Button
                variant="outline"
                icon="refresh"
                requires="operator"
                loading={readMeters.pending}
                onClick={() => void readMeters.run(vars)}
              >
                Read meters now
              </Button>
            )}
            <Button
              variant="outline"
              icon="refresh"
              requires="operator"
              loading={reload.pending}
              onClick={() => void reload.run(vars)}
            >
              Reload
            </Button>
            <Toggle
              boxed
              label="Enabled"
              checked={executor.enabled}
              requires="operator"
              onChange={(next) => void enable.run({ id: executor.id, enabled: next })}
            />
          </>
        }
      />

      <div className={styles.facts}>
        {executor.tracking === 'callback' && (
          <span className={styles.fact}>
            <Icon name="link" size={13} />
            callback
            <span className={`${styles.url} mono`} title={executor.callbackUrl}>
              {executor.callbackUrl}
            </span>
            <CopyButton value={executor.callbackUrl} label="Copy callback URL" />
          </span>
        )}
        <SecretRefsFact refs={executor.secretRefs} />
      </div>

      {executor.softHoldUntil && (
        <Banner
          tone="warn"
          title="Soft hold"
          actions={
            <Button
              size="sm"
              variant="outline"
              requires="operator"
              loading={clearHold.pending}
              onClick={() => void clearHold.run(vars)}
            >
              Clear soft hold
            </Button>
          }
        >
          {executor.softHoldReason ?? 'The backend asked Switchboard to back off.'} No new runs
          start until it lifts <Countdown until={executor.softHoldUntil} prefix="in" />.
        </Banner>
      )}
      <InstanceStateBanners
        noun="executor"
        typeName={executor.typeName}
        pluginAvailable={executor.pluginAvailable}
        instanceError={executor.instanceError}
        heldProcesses="the processes bound to it are held"
        onReload={() => void reload.run(vars)}
      />

      <RoutedTabs
        label="Executor sections"
        items={[
          { to: base, label: 'Overview', end: true },
          { to: `${base}/settings`, label: 'Settings' },
          { to: `${base}/runs`, label: 'Runs', count: executor.runs24h },
        ]}
      />

      {tab === undefined ? (
        <ExecutorOverview executor={executor} />
      ) : tab === 'settings' ? (
        <ExecutorSettings key={executor.id} executor={executor} />
      ) : tab === 'runs' ? (
        <ExecutorRuns executor={executor} />
      ) : (
        <UnknownTab overview={base} />
      )}
    </>
  );
}
