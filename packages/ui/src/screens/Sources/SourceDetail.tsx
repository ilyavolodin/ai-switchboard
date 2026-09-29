import type { SourceDetail as SourceDetailDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import {
  useEnableSource,
  useProvisionSource,
  useReloadSource,
  useSendTestEvent,
  useSource,
} from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Icon } from '../../components/Icon.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { formatInterval } from '../../lib/instances.js';
import { reloadedMessage, reloadPrompt, testEventPrompt } from '../shared/actionPrompts.js';
import { InstanceStateBanners } from '../shared/InstanceStateBanners.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { CopyButton } from '../../components/CopyButton.js';
import styles from '../shared/detail.module.css';
import { SecretRefsFact } from '../shared/SecretRefsFact.js';
import { SourceEventsTab } from './SourceEventsTab.js';
import { SourceOverview } from './SourceOverview.js';
import { enableSourcePrompt, modeLabel } from './sourceModel.js';
import { SourceSettings } from './SourceSettings.js';
import { TestEventResult } from './TestEventResult.js';

export function SourceDetail() {
  const { id, tab } = useParams();
  const source = useSource(id);

  if (source.isPending) {
    return <Skeleton shape="card" height={320} label="Loading the source" />;
  }
  if (source.isError) {
    return (
      <LoadFailure error={source.error} noun="source" listTo="/sources" listLabel="All sources" />
    );
  }
  return <SourceView source={source.data} tab={tab} />;
}

function SourceView({ source, tab }: { source: SourceDetailDTO; tab: string | undefined }) {
  const base = `/sources/${source.id}`;
  const events24h = source.eventsByType24h.reduce((s, t) => s + t.count, 0);
  const [sentTest, setSentTest] = useState<string[] | null>(null);
  const vars = { id: source.id };
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
  const reload = useReasonedMutation(useReloadSource(), reloadPrompt('source', source.name), {
    successMessage: reloadedMessage('source'),
  });
  const enable = useReasonedMutation(useEnableSource(), (v: { id: string; enabled: boolean }) =>
    enableSourcePrompt(source, v.enabled),
  );

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
              loading={reload.pending}
              onClick={() => void reload.run(vars)}
            >
              Reload
            </Button>
            <Toggle
              boxed
              label="Enabled"
              value={source.enabled}
              requires="operator"
              onChange={(next) => void enable.run({ id: source.id, enabled: next })}
            />
          </>
        }
      />

      <div className={styles.facts}>
        {source.webhookUrl ? (
          <span className={styles.fact}>
            <Icon name="webhook" size={13} />
            webhook
            <span className={`${styles.url} mono`} title={source.webhookUrl}>
              {source.webhookUrl}
            </span>
            <CopyButton value={source.webhookUrl} label="Copy webhook URL" />
          </span>
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
        onReload={() => void reload.run(vars)}
      />

      <RoutedTabs
        label="Source sections"
        items={[
          { to: base, label: 'Overview', end: true },
          { to: `${base}/settings`, label: 'Settings' },
          { to: `${base}/events`, label: 'Events', count: events24h },
        ]}
      />

      {tab === undefined ? (
        <SourceOverview source={source} />
      ) : tab === 'settings' ? (
        <SourceSettings key={source.id} source={source} />
      ) : tab === 'events' ? (
        <SourceEventsTab source={source} />
      ) : (
        <UnknownTab to={base} />
      )}
    </>
  );
}
