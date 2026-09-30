import type { DestinationCapsDTO } from '@ai-switchboard/core/contract';

import { useCreateDestination, useDestinations, usePluginTypes } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { plural } from '../../lib/format.js';
import { destinationHref } from '../../lib/hrefs.js';
import { AddInstanceDialog } from '../shared/AddInstanceDialog.js';
import { InstanceGrid } from '../shared/InstanceGrid.js';
import styles from '../shared/instanceCard.module.css';
import { useAddInstance } from '../shared/useAddInstance.js';
import { DestinationCapsFields } from './DestinationCapsFields.js';
import { DestinationCard } from './DestinationCard.js';
import { describeDestinationType, estimatedMeters } from './destinationModel.js';

export function Destinations() {
  const destinations = useDestinations();
  const types = usePluginTypes('destination');
  const add = useAddInstance({
    noun: 'destination',
    mutation: useCreateDestination(),
    consequence:
      'The destination is ready as soon as it is created; no process runs on it until one binds to it.',
    href: (id) => destinationHref(id),
  });

  const list = destinations.data ?? [];
  const typeCount = new Set(list.map((x) => x.typeId)).size;
  const addButton = (
    <Button variant="primary" icon="plus" requires="operator" onClick={add.open}>
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
              {plural(list.length, 'instance')} · {plural(typeCount, 'type')}
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
        footer={
          <p className={`t-caption ${styles.footNote}`}>
            A tick on an arc is a process ceiling: event runs hold above it, sweeps a little later.
            A grey arc means the last reading is stale and only the run counters gate.
          </p>
        }
        empty={
          <EmptyState title="No destinations yet" illustration="ghost" actions={addButton}>
            A destination starts the automations you already have: a Claude Routine, an HTTP
            endpoint, a GitHub Actions workflow. Add one, then bind a process to it.
          </EmptyState>
        }
      />

      <AddInstanceDialog<DestinationCapsDTO>
        open={add.adding}
        onClose={add.close}
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
        onSubmit={add.submit}
      />
    </>
  );
}
