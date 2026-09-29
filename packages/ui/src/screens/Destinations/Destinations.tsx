import type { DestinationCapsDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCreateDestination, useDestinations, usePluginTypes } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { withoutUndefined } from '../../lib/instances.js';
import { InstanceGrid } from '../shared/InstanceGrid.js';
import { AddInstanceDialog } from '../Sources/AddInstanceDialog.js';
import { DestinationCapsFields } from './DestinationCapsFields.js';
import { DestinationCard } from './DestinationCard.js';
import { describeDestinationType, estimatedMeters } from './destinationModel.js';

export function Destinations() {
  const destinations = useDestinations();
  const types = usePluginTypes('destination');
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const create = useReasonedMutation(
    useCreateDestination(),
    (v: { name: string }) => ({
      title: `Create ${v.name}?`,
      consequence:
        'The destination is ready as soon as it is created; no process runs on it until one binds to it.',
      confirmLabel: 'Create destination',
    }),
    { successMessage: (d) => `${d.name} created` },
  );

  const list = destinations.data ?? [];
  const typeCount = new Set(list.map((x) => x.typeId)).size;
  const tick = (
    <p className="t-caption" style={{ margin: 0 }}>
      A tick on an arc is a process ceiling: event runs hold above it, sweeps a little later. A grey
      arc means the last reading is stale and only the run counters gate.
    </p>
  );
  const addButton = (
    <Button
      variant="primary"
      icon="plus"
      requires="operator"
      onClick={() => {
        setAdding(true);
      }}
    >
      Add destination
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Destinations"
        meta={
          destinations.data ? (
            <span className="t-caption">
              {list.length} instance{list.length === 1 ? '' : 's'} · {typeCount} type
              {typeCount === 1 ? '' : 's'}
            </span>
          ) : null
        }
        actions={addButton}
      />
      <InstanceGrid
        query={destinations}
        title="Destinations"
        heldNote="the processes bound to them are held until it is back."
        renderCard={(x) => <DestinationCard key={x.id} destination={x} />}
        footer={tick}
        empty={
          <EmptyState title="No destinations yet" illustration="ghost" actions={addButton}>
            A destination starts the automations you already have: a Claude Routine, an HTTP
            endpoint, a GitHub Actions workflow. Add one, then bind a process to it.
          </EmptyState>
        }
      />

      <AddInstanceDialog<DestinationCapsDTO>
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        kind="destination"
        types={types.data}
        loading={types.isPending}
        describeType={describeDestinationType}
        initialCaps={() => ({})}
        renderCaps={(t, caps, onChange) => (
          <DestinationCapsFields
            value={caps}
            onChange={onChange}
            usage={t.usage ?? []}
            estimated={estimatedMeters(t.meters ?? [])}
            hasMeters={(t.meters?.length ?? 0) > 0}
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
          void navigate(`/destinations/${created.id}`);
          return true;
        }}
      />
    </>
  );
}
