import type { SourceCapsDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCreateSource, usePluginTypes, useSources } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { withoutUndefined } from '../../lib/instances.js';
import { InstanceGrid } from '../shared/InstanceGrid.js';
import { AddInstanceDialog } from '../shared/AddInstanceDialog.js';
import styles from '../shared/instanceCard.module.css';
import { SamplePreview } from './SamplePreview.js';
import { SourceCapsFields } from './SourceCapsFields.js';
import { SourceCard } from './SourceCard.js';
import { describeSourceType } from './sourceModel.js';

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
  const addButton = (
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
  );

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
            {addButton}
          </>
        }
      />

      <InstanceGrid
        query={sources}
        title="Sources"
        heldNote="the processes they feed are held until it is back. See Plugins."
        renderCard={(s) => <SourceCard key={s.id} source={s} />}
        empty={
          <EmptyState title="No sources yet" illustration="ghost" actions={addButton}>
            A source turns deliveries from a system you already run (GitHub, Linear, Datadog, any
            webhook) into events. Add one, then give a process a trigger on it.
          </EmptyState>
        }
      />

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
            // A dynamic type (webhook) declares its event types in this very form; the mute
            // list appears in Settings once the instance exists.
            eventTypes={t.dynamicEventTypes ? [] : (t.eventTypes ?? [])}
            mode={t.mode}
          />
        )}
        sample={{
          applies: (t) => t.mode !== 'pull',
          render: ({ type, settings, sample, onSampleChange }) => (
            <SamplePreview
              typeId={type.typeId}
              settings={settings}
              sample={sample}
              onSampleChange={onSampleChange}
            />
          ),
        }}
        onSubmit={async ({ type, name, settings, caps }) => {
          const created = await create.run({
            typeId: type.typeId,
            name,
            settings,
            caps: withoutUndefined(caps),
            enabled: true,
          });
          if (!created) return false;
          setAdding(false);
          void navigate(`/sources/${created.id}`);
          return true;
        }}
      />
    </>
  );
}
