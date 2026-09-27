import type { SourceDetail as SourceDetailDTO } from '@ai-switchboard/core/contract';
import { useParams } from 'react-router';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import {
  useEnableSource,
  useProvisionSource,
  useReloadSource,
  useSendTestEvent,
  useSource,
} from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Icon } from '../../components/Icon.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { formatInterval } from '../../lib/instances.js';
import { CopyButton } from './CopyButton.js';
import styles from './detail.module.css';
import { SecretRefsFact } from './SecretRefsFact.js';
import { SourceEventsTab } from './SourceEventsTab.js';
import { SourceOverview } from './SourceOverview.js';
import { enableSourcePrompt, modeLabel } from './sourceModel.js';
import { SourceSettings } from './SourceSettings.js';

/**
 * A source instance: header (status, webhook URL or poll interval, secret references, Register
 * webhook, Send test event, Reload, Enabled) and the Overview / Settings / Events tabs.
 */
export function SourceDetail() {
  const { id, tab } = useParams();
  const source = useSource(id);

  if (source.isPending) {
    return <Skeleton shape="card" height={320} label="Loading the source" />;
  }
  if (source.isError) {
    const missing = isApiRequestError(source.error) && source.error.status === 404;
    return (
      <EmptyState
        title={missing ? 'This source does not exist' : 'The source could not load'}
        actions={
          <LinkButton to="/sources" variant="outline">
            All sources
          </LinkButton>
        }
      >
        {missing ? 'It may have been deleted.' : errorMessage(source.error)}
      </EmptyState>
    );
  }
  return <SourceView source={source.data} tab={tab} />;
}

function SourceView({ source, tab }: { source: SourceDetailDTO; tab: string | undefined }) {
  const base = `/sources/${source.id}`;
  const events24h = source.eventsByType24h.reduce((s, t) => s + t.count, 0);
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
  const testEvent = useReasonedMutation(
    useSendTestEvent(),
    {
      title: `Send a test event from ${source.name}?`,
      consequence:
        'A synthetic event walks the pipeline like a real one: processes whose triggers match it will batch and may run.',
      confirmLabel: 'Send test event',
    },
    {
      successMessage: (d) =>
        `Test event sent${d.eventIds.length ? ` · ${d.eventIds.join(', ')}` : ''}`,
    },
  );
  const reload = useReasonedMutation(
    useReloadSource(),
    {
      title: `Reload ${source.name}?`,
      consequence:
        'The live plugin object is re-created from the saved settings and secrets are resolved again.',
      confirmLabel: 'Reload',
    },
    { successMessage: 'Source reloaded' },
  );
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
              onClick={() => void testEvent.run(vars)}
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
              checked={source.enabled}
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

      {!source.pluginAvailable && (
        <Banner tone="warn" title="Plugin unavailable">
          The {source.typeName} plugin did not load at start. This source stays configured, but its
          processes are held until the plugin is back.
        </Banner>
      )}
      {source.instanceError && (
        <Banner
          tone="error"
          title="The source is not running"
          actions={
            <Button
              size="sm"
              variant="outline"
              requires="operator"
              onClick={() => void reload.run(vars)}
            >
              Reload
            </Button>
          }
        >
          {source.instanceError}
        </Banner>
      )}

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
        <EmptyState
          title="No such tab"
          compact
          actions={
            <LinkButton to={base} variant="outline">
              Overview
            </LinkButton>
          }
        />
      )}
    </>
  );
}
