import type { DestinationDetail as DestinationDetailDTO } from '@ai-switchboard/core/contract';
import { useParams } from 'react-router';

import {
  useClearSoftHold,
  useEnableDestination,
  useDestination,
  useReadMeters,
  useReloadDestination,
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
import { readMetersPrompt, reloadedMessage, reloadPrompt } from '../shared/actionPrompts.js';
import { InstanceStateBanners } from '../shared/InstanceStateBanners.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { CopyButton } from '../../components/CopyButton.js';
import styles from '../shared/detail.module.css';
import { SecretRefsFact } from '../shared/SecretRefsFact.js';
import { enableDestinationPrompt } from './destinationModel.js';
import { DestinationOverview } from './DestinationOverview.js';
import { DestinationRuns } from './DestinationRuns.js';
import { DestinationSettings } from './DestinationSettings.js';

export function DestinationDetail() {
  const { id, tab } = useParams();
  const destination = useDestination(id);

  if (destination.isPending) {
    return <Skeleton shape="card" height={320} label="Loading the destination" />;
  }
  if (destination.isError) {
    return (
      <LoadFailure
        error={destination.error}
        noun="destination"
        listTo="/destinations"
        listLabel="All destinations"
      />
    );
  }
  return <DestinationView destination={destination.data} tab={tab} />;
}

function DestinationView({
  destination,
  tab,
}: {
  destination: DestinationDetailDTO;
  tab: string | undefined;
}) {
  const base = `/destinations/${destination.id}`;
  const vars = { id: destination.id };
  const readMeters = useReasonedMutation(useReadMeters(), readMetersPrompt(destination.name), {
    successMessage: (d) => `Read ${d.length} meter${d.length === 1 ? '' : 's'}`,
  });
  const clearHold = useReasonedMutation(
    useClearSoftHold(),
    {
      title: `Clear the soft hold on ${destination.name}?`,
      consequence:
        'Runs may start on it again right away, before the backend said it was ready. Held batches go on the next sweep.',
      confirmLabel: 'Clear soft hold',
      danger: true,
    },
    { successMessage: 'Soft hold cleared' },
  );
  const reload = useReasonedMutation(
    useReloadDestination(),
    reloadPrompt('destination', destination.name),
    { successMessage: reloadedMessage('destination') },
  );
  const enable = useReasonedMutation(
    useEnableDestination(),
    (v: { id: string; enabled: boolean }) => enableDestinationPrompt(destination, v.enabled),
  );

  return (
    <>
      <PageHeader
        title={destination.name}
        back={{ to: '/destinations', label: 'Back to destinations' }}
        meta={
          <>
            <StatusChip tone={destination.status.tone} label={destination.status.label} />
            {destination.softHoldUntil && <StatusChip tone="warn" label="soft hold" />}
            <span className="t-caption">
              <span className="mono">{destination.typeId}</span> · {destination.tracking} tracking ·{' '}
              {destination.idempotentInvoke ? 'idempotent' : 'not idempotent'}
            </span>
          </>
        }
        actions={
          <>
            {destination.meterSpecs.length > 0 && (
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
              checked={destination.enabled}
              requires="operator"
              onChange={(next) => void enable.run({ id: destination.id, enabled: next })}
            />
          </>
        }
      />

      <div className={styles.facts}>
        {destination.tracking === 'callback' && (
          <span className={styles.fact}>
            <Icon name="link" size={13} />
            callback
            <span className={`${styles.url} mono`} title={destination.callbackUrl}>
              {destination.callbackUrl}
            </span>
            <CopyButton value={destination.callbackUrl} label="Copy callback URL" />
          </span>
        )}
        <SecretRefsFact refs={destination.secretRefs} />
      </div>

      {destination.softHoldUntil && (
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
          {destination.softHoldReason ?? 'The backend asked Switchboard to back off.'} No new runs
          start until it lifts <Countdown until={destination.softHoldUntil} prefix="in" />.
        </Banner>
      )}
      <InstanceStateBanners
        noun="destination"
        typeName={destination.typeName}
        pluginAvailable={destination.pluginAvailable}
        instanceError={destination.instanceError}
        heldProcesses="the processes bound to it are held"
        onReload={() => void reload.run(vars)}
      />

      <RoutedTabs
        label="Destination sections"
        items={[
          { to: base, label: 'Overview', end: true },
          { to: `${base}/settings`, label: 'Settings' },
          { to: `${base}/runs`, label: 'Runs', count: destination.runs24h },
        ]}
      />

      {tab === undefined ? (
        <DestinationOverview destination={destination} />
      ) : tab === 'settings' ? (
        <DestinationSettings key={destination.id} destination={destination} />
      ) : tab === 'runs' ? (
        <DestinationRuns destination={destination} />
      ) : (
        <UnknownTab to={base} />
      )}
    </>
  );
}
