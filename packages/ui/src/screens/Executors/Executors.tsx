import type { ExecutorCapsDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCreateExecutor, useExecutors, usePluginTypes } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { withoutUndefined } from '../../lib/instances.js';
import { InstanceGrid } from '../shared/InstanceGrid.js';
import { AddInstanceDialog } from '../Sources/AddInstanceDialog.js';
import { ExecutorCapsFields } from './ExecutorCapsFields.js';
import { ExecutorCard } from './ExecutorCard.js';
import { describeExecutorType, estimatedMeters } from './executorModel.js';

/**
 * Executors: one card per executor instance with its meters as arcs, and the "Add executor"
 * flow (the type's settings form plus the core's caps).
 */
export function Executors() {
  const executors = useExecutors();
  const types = usePluginTypes('executor');
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const create = useReasonedMutation(
    useCreateExecutor(),
    (v: { name: string }) => ({
      title: `Create ${v.name}?`,
      consequence:
        'The executor is ready as soon as it is created; no process runs on it until one binds to it.',
      confirmLabel: 'Create executor',
    }),
    { successMessage: (d) => `${d.name} created` },
  );

  const list = executors.data ?? [];
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
      Add executor
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Executors"
        meta={
          executors.data ? (
            <span className="t-caption">
              {list.length} instance{list.length === 1 ? '' : 's'} · {typeCount} type
              {typeCount === 1 ? '' : 's'}
            </span>
          ) : null
        }
        actions={addButton}
      />
      <InstanceGrid
        query={executors}
        title="Executors"
        heldNote="the processes bound to them are held until it is back."
        renderCard={(x) => <ExecutorCard key={x.id} executor={x} />}
        footer={tick}
        empty={
          <EmptyState title="No executors yet" illustration="ghost" actions={addButton}>
            An executor starts the automations you already have: a Claude Routine, an HTTP endpoint,
            a GitHub Actions workflow. Add one, then bind a process to it.
          </EmptyState>
        }
      />

      <AddInstanceDialog<ExecutorCapsDTO>
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        kind="executor"
        types={types.data}
        loading={types.isPending}
        describeType={describeExecutorType}
        initialCaps={() => ({})}
        renderCaps={(t, caps, onChange) => (
          <ExecutorCapsFields
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
          void navigate(`/executors/${created.id}`);
          return true;
        }}
      />
    </>
  );
}
