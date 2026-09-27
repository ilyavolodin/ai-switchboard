import type { PluginTypeDTO, SourceCapsDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useCreateSource, usePluginTypes, useSources } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Skeleton } from '../../components/Skeleton.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { withoutUndefined } from '../../lib/instances.js';
import { AddInstanceDialog } from './AddInstanceDialog.js';
import styles from './instanceCard.module.css';
import { SourceCapsFields } from './SourceCapsFields.js';
import { SourceCard } from './SourceCard.js';

function describeSourceType(t: PluginTypeDTO): string {
  const n = t.eventTypes?.length ?? 0;
  return [
    t.mode === 'both' ? 'push and pull' : (t.mode ?? 'push'),
    t.dynamicEventTypes ? 'dynamic event types' : `${n} event type${n === 1 ? '' : 's'}`,
    t.provisionSupported ? 'registers its webhook' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Sources: one card per source instance (health, last event, events per hour and by type,
 * enabled toggle) and the "Add source" flow.
 */
export function Sources() {
  const sources = useSources();
  const types = usePluginTypes('source');
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const create = useReasonedMutation(
    useCreateSource(),
    (v: { name: string }) => ({
      title: `Create ${v.name}?`,
      consequence:
        'The source starts receiving events as soon as it is created. No process uses it until a trigger names it.',
      confirmLabel: 'Create source',
    }),
    { successMessage: (d) => `${d.name} created` },
  );

  const list = sources.data ?? [];
  const enabled = list.filter((s) => s.enabled).length;

  return (
    <>
      <PageHeader
        title="Sources"
        meta={
          sources.data ? (
            <span className="t-caption">
              {list.length} source{list.length === 1 ? '' : 's'} · {enabled} enabled
            </span>
          ) : null
        }
        actions={
          <>
            <span className={styles.legendKeys} aria-hidden="true">
              <span className={styles.legendKey}>
                <span className={styles.legendSwatch} style={{ background: 'var(--primary)' }} />
                events received
              </span>
              <span className={styles.legendKey}>
                <span className={styles.legendSwatch} style={{ background: 'var(--st-warn)' }} />
                source-throttled
              </span>
            </span>
            <Button
              variant="primary"
              icon="plus"
              requires="operator"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add source
            </Button>
          </>
        }
      />

      {sources.isPending ? (
        <div className={styles.grid}>
          <Skeleton shape="card" height={220} label="Loading sources" />
          <Skeleton shape="card" height={220} />
          <Skeleton shape="card" height={220} />
        </div>
      ) : sources.isError ? (
        <Banner
          tone="error"
          title="Sources could not load"
          actions={
            <Button size="sm" variant="outline" onClick={() => void sources.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(sources.error)}
        </Banner>
      ) : list.length === 0 ? (
        <EmptyState
          title="No sources yet"
          illustration="ghost"
          actions={
            <Button
              variant="primary"
              icon="plus"
              requires="operator"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add source
            </Button>
          }
        >
          A source turns deliveries from a system you already run (GitHub, Linear, Datadog, any
          webhook) into events. Add one, then give a process a trigger on it.
        </EmptyState>
      ) : (
        <>
          {list.some((s) => !s.pluginAvailable) && (
            <Banner tone="warn" title="A plugin is unavailable">
              {list
                .filter((s) => !s.pluginAvailable)
                .map((s) => s.name)
                .join(', ')}{' '}
              stay configured, but their plugin did not load at start; the processes they feed are
              held until it is back. See Plugins.
            </Banner>
          )}
          <div className={styles.grid}>
            {list.map((s) => (
              <SourceCard key={s.id} source={s} />
            ))}
          </div>
        </>
      )}

      <AddInstanceDialog<SourceCapsDTO>
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        kind="source"
        types={types.data}
        loading={types.isPending}
        describeType={describeSourceType}
        initialCaps={() => ({})}
        renderCaps={(t, caps, onChange) => (
          <SourceCapsFields
            value={caps}
            onChange={onChange}
            eventTypes={t.eventTypes ?? []}
            mode={t.mode}
          />
        )}
        onSubmit={async ({ type, name, settings, caps }) => {
          setAdding(false);
          const created = await create.run({
            typeId: type.typeId,
            name,
            settings,
            caps: withoutUndefined(caps),
            enabled: true,
          });
          if (!created) {
            setAdding(true);
            return false;
          }
          void navigate(`/sources/${created.id}`);
          return true;
        }}
      />
    </>
  );
}
