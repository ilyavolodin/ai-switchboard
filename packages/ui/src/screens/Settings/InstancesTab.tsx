import { useState } from 'react';

import { usedByOf } from '../../api/client.js';
import {
  type InstanceRoute,
  useDeleteInstance,
  useEnableInstance,
  useInstances,
  useReloadInstance,
  useTestNotifier,
} from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { reloadedMessage, reloadPrompt } from '../shared/actionPrompts.js';
import { InstanceEditorDrawer, type InstanceEditing } from './InstanceEditorDrawer.js';
import { InstanceRow } from './InstanceRow.js';
import {
  deleteInstancePrompt,
  enableInstancePrompt,
  INSTANCE_ROUTES,
  testNotifierPrompt,
} from './instancesModel.js';
import styles from './Settings.module.css';

export function InstancesTab({ route }: { route: InstanceRoute }) {
  const copy = INSTANCE_ROUTES[route];
  const instances = useInstances(route);
  const [editing, setEditing] = useState<InstanceEditing | null>(null);
  const [showingSecrets, setShowingSecrets] = useState<string | null>(null);
  const nameOf = (id: string) => instances.data?.find((i) => i.id === id)?.name ?? copy.one;

  const enable = useReasonedMutation(useEnableInstance(route), (v) =>
    enableInstancePrompt(route, nameOf(v.id), v.enabled),
  );
  const reload = useReasonedMutation(
    useReloadInstance(route),
    (v) => reloadPrompt(copy.one, nameOf(v.id)),
    { successMessage: reloadedMessage(copy.one) },
  );
  const test = useReasonedMutation(useTestNotifier(), (v) => testNotifierPrompt(nameOf(v.id)), {
    successMessage: 'Test notification sent',
  });
  const remove = useReasonedMutation(
    useDeleteInstance(route),
    (v) => deleteInstancePrompt(route, nameOf(v.id)),
    { successMessage: 'Deleted', onError: (e) => usedByOf(e) != null },
  );
  const refusalFor = (id: string) =>
    remove.mutation.isError && remove.mutation.variables.id === id
      ? { usedBy: usedByOf(remove.mutation.error), error: remove.mutation.error }
      : null;

  return (
    <Card
      title={copy.title}
      subtitle={copy.subtitle}
      actions={
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          requires="admin"
          onClick={() => {
            setEditing({ mode: 'create' });
          }}
        >
          Add {copy.one}
        </Button>
      }
    >
      <QueryBoundary
        query={instances}
        errorTitle={`${copy.title} could not load`}
        pending={<Skeleton lines={3} height={24} label={`Loading ${copy.title.toLowerCase()}`} />}
        empty={
          <EmptyState title={`No ${copy.title.toLowerCase()} yet`} compact>
            {copy.empty}
          </EmptyState>
        }
      >
        {(list) => (
          <ul className={styles.list} aria-label={copy.title}>
            {list.map((inst) => (
              <InstanceRow
                key={inst.id}
                instance={inst}
                copy={copy}
                showingSecrets={showingSecrets === inst.id}
                deleteRefusal={refusalFor(inst.id)}
                onDismissRefusal={() => {
                  remove.mutation.reset();
                }}
                onToggleSecrets={() => {
                  setShowingSecrets((cur) => (cur === inst.id ? null : inst.id));
                }}
                onEnable={(next) => void enable.run({ id: inst.id, enabled: next })}
                onEdit={() => {
                  setEditing({ mode: 'edit', instance: inst });
                }}
                onReload={() => void reload.run({ id: inst.id })}
                onTest={() => void test.run({ id: inst.id })}
                onDelete={() => void remove.run({ id: inst.id })}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      {editing && (
        <InstanceEditorDrawer
          route={route}
          editing={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}
