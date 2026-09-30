import type { DestinationDetail as DestinationDetailDTO } from '@ai-switchboard/core/contract';
import { useParams } from 'react-router';

import { useClearSoftHold, useDestination, useReadMeters } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Countdown } from '../../components/Countdown.js';
import { PageHeader } from '../../components/PageHeader.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { plural } from '../../lib/format.js';
import { destinationHref } from '../../lib/hrefs.js';
import { readMetersPrompt } from '../shared/actionPrompts.js';
import styles from '../shared/detail.module.css';
import { DetailTabs } from '../shared/DetailTabs.js';
import { InstanceDetailShell } from '../shared/InstanceDetailShell.js';
import { InstanceStateBanners } from '../shared/InstanceStateBanners.js';
import { SecretRefsFact } from '../shared/SecretRefsFact.js';
import { UrlFact } from '../shared/UrlFact.js';
import { DestinationOverview } from './DestinationOverview.js';
import { DestinationRuns } from './DestinationRuns.js';
import { DestinationSettings } from './DestinationSettings.js';
import { useDestinationActions } from './useDestinationActions.js';

export function DestinationDetail() {
  const { id, tab } = useParams();
  return (
    <InstanceDetailShell query={useDestination(id)} noun="destination" listTo="/destinations">
      {(destination) => <DestinationView destination={destination} tab={tab} />}
    </InstanceDetailShell>
  );
}

function DestinationView({
  destination,
  tab,
}: {
  destination: DestinationDetailDTO;
  tab: string | undefined;
}) {
  const base = destinationHref(destination.id);
  const vars = { id: destination.id };
  const actions = useDestinationActions(destination);
  const readMeters = useReasonedMutation(useReadMeters(), readMetersPrompt(destination.name), {
    successMessage: (d) => `Read ${plural(d.length, 'meter')}`,
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
              loading={actions.reloading}
              onClick={actions.reload}
            >
              Reload
            </Button>
            <Toggle
              boxed
              label="Enabled"
              value={destination.enabled}
              requires="operator"
              onChange={actions.setEnabled}
            />
          </>
        }
      />

      <div className={styles.facts}>
        {destination.tracking === 'callback' && (
          <UrlFact icon="link" label="callback" url={destination.callbackUrl} />
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
        onReload={actions.reload}
      />

      <DetailTabs
        label="Destination sections"
        base={base}
        tab={tab}
        tabs={[
          { label: 'Overview', render: () => <DestinationOverview destination={destination} /> },
          {
            segment: 'settings',
            label: 'Settings',
            render: () => <DestinationSettings key={destination.id} destination={destination} />,
          },
          {
            segment: 'runs',
            label: 'Runs',
            count: destination.runs24h,
            render: () => <DestinationRuns destination={destination} />,
          },
        ]}
      />
    </>
  );
}
