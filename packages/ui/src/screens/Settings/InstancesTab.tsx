import type { InstanceSummary, JSONSchema } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import {
  type InstanceRoute,
  useCreateInstance,
  useDeleteInstance,
  useEnableInstance,
  useInstances,
  usePluginTypes,
  useReloadInstance,
  useSecretProviders,
  useTestNotifier,
  useUpdateInstance,
} from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Drawer } from '../../components/Drawer.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Field } from '../../components/Field.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { TextField } from '../../components/TextField.js';
import { Toggle } from '../../components/Toggle.js';
import { useCan } from '../../app/session.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { asRecord, secretProviderIds } from '../../lib/instances.js';
import { schemaDefaults, validateAgainstSchema } from '../../lib/schema.js';
import { ProviderDependents } from './ProviderDependents.js';
import { ProviderSecrets } from './ProviderSecrets.js';
import styles from './Settings.module.css';

const COPY = {
  notifiers: {
    title: 'Notifiers',
    one: 'notifier',
    kind: 'notifier',
    subtitle: 'where breakers, approvals and process notifications are posted',
    empty: 'Add a notifier (Slack, a webhook) so breakers and approvals reach people.',
  },
  'secret-providers': {
    title: 'Secret providers',
    one: 'secret provider',
    kind: 'secret_provider',
    subtitle: 'resolve secret://<provider>/<name> references; values never reach the database',
    empty: 'Add a secret provider so settings can reference secrets instead of holding them.',
  },
} as const;

type Editing = { mode: 'create' } | { mode: 'edit'; instance: InstanceSummary } | null;

/** Notifier or secret-provider instances: list, schema-form create/edit, enable, reload, delete. */
export function InstancesTab({ route }: { route: InstanceRoute }) {
  const copy = COPY[route];
  const instances = useInstances(route);
  const [editing, setEditing] = useState<Editing>(null);
  const [showingSecrets, setShowingSecrets] = useState<string | null>(null);
  const nameOf = (id: string) => instances.data?.find((i) => i.id === id)?.name ?? copy.one;

  const enable = useReasonedMutation(useEnableInstance(route), (v) => ({
    title: `${v.enabled ? 'Enable' : 'Disable'} ${nameOf(v.id)}?`,
    consequence: v.enabled
      ? `The ${copy.one} is used again from now on.`
      : route === 'notifiers'
        ? 'Notifications routed to it are dropped until it is enabled again.'
        : 'References to it stop resolving; instances that need them fail to reload.',
    confirmLabel: v.enabled ? 'Enable' : 'Disable',
    danger: !v.enabled,
  }));
  const reload = useReasonedMutation(
    useReloadInstance(route),
    (v) => ({
      title: `Reload ${nameOf(v.id)}?`,
      consequence: 'Re-creates it from its settings and re-resolves its secret references.',
      confirmLabel: 'Reload',
    }),
    { successMessage: 'Reloaded' },
  );
  const test = useReasonedMutation(
    useTestNotifier(),
    (v) => ({
      title: `Send a test notification to ${nameOf(v.id)}?`,
      confirmLabel: 'Send test',
    }),
    { successMessage: 'Test notification sent' },
  );
  const remove = useReasonedMutation(
    useDeleteInstance(route),
    (v) => ({
      title: `Delete ${nameOf(v.id)}?`,
      consequence:
        route === 'notifiers'
          ? 'Processes that notify through it stop notifying.'
          : 'Every secret://' + nameOf(v.id) + '/… reference stops resolving.',
      confirmLabel: 'Delete',
      danger: true,
    }),
    { successMessage: 'Deleted' },
  );

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
      {instances.isPending ? (
        <Skeleton lines={3} height={24} label={`Loading ${copy.title.toLowerCase()}`} />
      ) : instances.isError ? (
        <Banner tone="error" title={`${copy.title} could not load`}>
          {errorMessage(instances.error)}
        </Banner>
      ) : instances.data.length === 0 ? (
        <EmptyState title={`No ${copy.title.toLowerCase()} yet`} compact>
          {copy.empty}
        </EmptyState>
      ) : (
        <ul className={styles.list} aria-label={copy.title}>
          {instances.data.map((inst) => (
            <li key={inst.id} className={styles.listItem} aria-label={inst.name}>
              <div className={styles.itemHead}>
                <span className={styles.itemName}>{inst.name}</span>
                <StatusChip size="sm" tone={inst.status.tone} label={inst.status.label} />
                <span className="t-caption">
                  {copy.one} · {inst.typeName}
                </span>
                <span style={{ flexGrow: 1 }} />
                <Toggle
                  size="sm"
                  label="Enabled"
                  checked={inst.enabled}
                  requires="admin"
                  onChange={(next) => void enable.run({ id: inst.id, enabled: next })}
                />
              </div>
              {inst.instanceError && (
                <Banner tone="error" title="It could not start">
                  {inst.instanceError}
                </Banner>
              )}
              {inst.health?.message && <span className="t-caption">{inst.health.message}</span>}
              {route === 'secret-providers' && inst.dependents && (
                <ProviderDependents provider={inst.name} dependents={inst.dependents} />
              )}
              {remove.mutation.isError && remove.mutation.variables.id === inst.id && (
                <Banner tone="error" title={`${inst.name} was not deleted`}>
                  {errorMessage(remove.mutation.error)}
                </Banner>
              )}
              {Object.keys(inst.settings).length > 0 && (
                <KeyValueList data={inst.settings} label={`${inst.name} settings`} />
              )}
              {route === 'secret-providers' && showingSecrets === inst.id && (
                <ProviderSecrets instance={inst} />
              )}
              <div className={styles.rowActions}>
                {route === 'secret-providers' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="key"
                    requires="admin"
                    aria-expanded={showingSecrets === inst.id}
                    aria-label={`${showingSecrets === inst.id ? 'Hide' : 'Show'} secrets in ${inst.name}`}
                    onClick={() => {
                      setShowingSecrets((cur) => (cur === inst.id ? null : inst.id));
                    }}
                  >
                    Secrets
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  requires="admin"
                  aria-label={`Edit ${inst.name}`}
                  onClick={() => {
                    setEditing({ mode: 'edit', instance: inst });
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="refresh"
                  requires="admin"
                  aria-label={`Reload ${inst.name}`}
                  onClick={() => void reload.run({ id: inst.id })}
                >
                  Reload
                </Button>
                {route === 'notifiers' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="play"
                    requires="admin"
                    aria-label={`Send a test notification to ${inst.name}`}
                    onClick={() => void test.run({ id: inst.id })}
                  >
                    Test
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger-outline"
                  icon="trash"
                  requires="admin"
                  aria-label={`Delete ${inst.name}`}
                  onClick={() => void remove.run({ id: inst.id })}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <InstanceEditor
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

function InstanceEditor({
  route,
  editing,
  onClose,
}: {
  route: InstanceRoute;
  editing: NonNullable<Editing>;
  onClose: () => void;
}) {
  const copy = COPY[route];
  const types = usePluginTypes(copy.kind);
  const secretProviders = useSecretProviders();
  const isAdmin = useCan('admin');
  const existing = editing.mode === 'edit' ? editing.instance : null;
  const [typeId, setTypeId] = useState(existing?.typeId ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [settings, setSettings] = useState<Record<string, unknown>>(existing?.settings ?? {});
  const [tried, setTried] = useState(false);

  const type = types.data?.find((t) => t.typeId === typeId);
  const schema: JSONSchema | undefined = existing?.settingsSchema ?? type?.settingsSchema;
  const errors = schema ? validateAgainstSchema(schema, settings) : {};
  const invalid = name.trim() === '' || schema == null || Object.keys(errors).length > 0;

  const create = useReasonedMutation(
    useCreateInstance(route),
    (v) => ({
      title: `Add the ${copy.one} “${v.name}”?`,
      confirmLabel: `Add ${copy.one}`,
    }),
    { successMessage: 'Added' },
  );
  const update = useReasonedMutation(
    useUpdateInstance(route),
    {
      title: `Save ${existing?.name ?? copy.one}?`,
      consequence: 'The instance reloads with the new settings.',
      confirmLabel: 'Save',
    },
    { successMessage: 'Saved' },
  );

  const onSave = async () => {
    setTried(true);
    if (invalid) return;
    const res = existing
      ? await update.run({ id: existing.id, name: name.trim(), settings })
      : await create.run({ typeId, name: name.trim(), settings, enabled: true });
    if (res) onClose();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width={520}
      title={existing ? `Edit ${existing.name}` : `Add a ${copy.one}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            requires="admin"
            loading={create.pending || update.pending}
            onClick={() => void onSave()}
          >
            {existing ? 'Save' : `Add ${copy.one}`}
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        {!existing && (
          <Field
            label="Type"
            required
            error={tried && !typeId ? 'Choose a type' : null}
            help={type?.description}
          >
            {({ id, describedBy, invalid: bad }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                invalid={bad}
                value={typeId}
                placeholder={types.isPending ? 'Loading types…' : 'Choose a type…'}
                options={(types.data ?? []).map((t) => ({
                  value: t.typeId,
                  label: t.displayName,
                  disabled: !t.available,
                }))}
                onChange={(e) => {
                  const next = types.data?.find((t) => t.typeId === e.target.value);
                  setTypeId(e.target.value);
                  setSettings(next ? asRecord(schemaDefaults(next.settingsSchema)) : {});
                }}
              />
            )}
          </Field>
        )}
        <Field label="Name" required error={tried && !name.trim() ? 'Name it' : null}>
          {({ id, describedBy, invalid: bad }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={bad}
              value={name}
              disabled={!isAdmin}
              placeholder={route === 'notifiers' ? 'Slack — #loops' : 'vault'}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        {schema && (
          <SchemaForm
            schema={schema}
            value={settings}
            onChange={setSettings}
            showAllErrors={tried}
            baseline={existing?.settings}
            secretProviders={secretProviderIds(secretProviders.data)}
            disabled={!isAdmin}
          />
        )}
      </div>
    </Drawer>
  );
}
