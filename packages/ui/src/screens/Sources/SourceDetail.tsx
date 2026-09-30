import type { SourceDetail as SourceDetailDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import { useProvisionSource, useSendTestEvent, useSource } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Icon } from '../../components/Icon.js';
import { PageHeader } from '../../components/PageHeader.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { sourceHref } from '../../lib/hrefs.js';
import { formatInterval } from '../../lib/instances.js';
import { testEventPrompt } from '../shared/actionPrompts.js';
import styles from '../shared/detail.module.css';
import { DetailTabs } from '../shared/DetailTabs.js';
import { InstanceDetailShell } from '../shared/InstanceDetailShell.js';
import { InstanceStateBanners } from '../shared/InstanceStateBanners.js';
import { SecretRefsFact } from '../shared/SecretRefsFact.js';
import { UrlFact } from '../shared/UrlFact.js';
import { SourceEventsTab } from './SourceEventsTab.js';
import { SourceOverview } from './SourceOverview.js';
import { modeLabel } from './sourceModel.js';
import { SourceSettings } from './SourceSettings.js';
import { TestEventResult } from './TestEventResult.js';
import { useSourceActions } from './useSourceActions.js';

export function SourceDetail() {
  const { id, tab } = useParams();
  return (
    <InstanceDetailShell query={useSource(id)} noun="source" listTo="/sources">
      {(source) => <SourceView source={source} tab={tab} />}
    </InstanceDetailShell>
  );
}

function SourceView({ source, tab }: { source: SourceDetailDTO; tab: string | undefined }) {
  const base = sourceHref(source.id);
  const events24h = source.eventsByType24h.reduce((s, t) => s + t.count, 0);
  const [sentTest, setSentTest] = useState<string[] | null>(null);
  const vars = { id: source.id };
  const actions = useSourceActions(source);
  const provision = useReasonedMutation(
    useProvisionSource(),
    {
      title: `Register the webhook for ${source.name}?`,
      consequence: `Switchboard asks ${source.typeName} to deliver events to this source's webhook URL.`,
      confirmLabel: 'Register webhook',
    },
    { successMessage: (d) => d.message || 'Webhook registered' },
  );
  const testEvent = useReasonedMutation(useSendTestEvent(), testEventPrompt(source.name), {
    successMessage: (d) =>
      `Test event sent${d.eventIds.length ? ` · ${d.eventIds.join(', ')}` : ''}`,
  });

  return (
    <>
      <PageHeader
        title={source.name}
        back={{ to: '/sources', label: 'Back to sources' }}
        meta={
          <>
            <StatusChip tone={source.status.tone} label={source.status.label} />
            {source.unauthenticated && <StatusChip tone="error" label="unauthenticated" />}
            <span className="t-caption">
              {source.typeName} · {modeLabel(source.mode)}
            </span>
          </>
        }
        actions={
          <>
            {source.provisionSupported && (
              <Button
                variant="outline"
                icon="webhook"
                requires="operator"
                loading={provision.pending}
                onClick={() => void provision.run(vars)}
              >
                Register webhook
              </Button>
            )}
            <Button
              variant="outline"
              icon="play"
              requires="operator"
              loading={testEvent.pending}
              onClick={() =>
                void testEvent.run(vars).then((d) => {
                  if (d && d.eventIds.length > 0) setSentTest(d.eventIds);
                })
              }
            >
              Send test event
            </Button>
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
              value={source.enabled}
              requires="operator"
              onChange={actions.setEnabled}
            />
          </>
        }
      />

      <div className={styles.facts}>
        {source.webhookUrl ? (
          <UrlFact icon="webhook" label="webhook" url={source.webhookUrl} />
        ) : source.pollIntervalSeconds != null ? (
          <span className={styles.fact}>
            <Icon name="clock" size={13} />
            polls {formatInterval(source.pollIntervalSeconds)}
          </span>
        ) : null}
        {source.provisionSupported && (
          <span className={styles.fact}>
            {source.provisionedAt ? (
              <>
                webhook registered <Time value={source.provisionedAt} />
              </>
            ) : (
              'webhook not registered yet'
            )}
          </span>
        )}
        <SecretRefsFact refs={source.secretRefs} />
      </div>

      {sentTest && (
        <TestEventResult
          key={sentTest.join(',')}
          eventIds={sentTest}
          onDismiss={() => {
            setSentTest(null);
          }}
        />
      )}

      <InstanceStateBanners
        noun="source"
        typeName={source.typeName}
        pluginAvailable={source.pluginAvailable}
        instanceError={source.instanceError}
        heldProcesses="its processes are held"
        onReload={actions.reload}
      />

      <DetailTabs
        label="Source sections"
        base={base}
        tab={tab}
        tabs={[
          { label: 'Overview', render: () => <SourceOverview source={source} /> },
          {
            segment: 'settings',
            label: 'Settings',
            render: () => <SourceSettings key={source.id} source={source} />,
          },
          {
            segment: 'events',
            label: 'Events',
            count: events24h,
            render: () => <SourceEventsTab source={source} />,
          },
        ]}
      />
    </>
  );
}
