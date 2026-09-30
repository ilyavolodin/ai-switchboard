import type { InstanceSummary, JSONSchema } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import {
  type InstanceRoute,
  useCreateInstance,
  usePluginTypes,
  useSecretNames,
  useSecretProviders,
  useUpdateInstance,
} from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Button } from '../../components/Button.js';
import { Drawer } from '../../components/Drawer.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { Select } from '../../components/Select.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { asRecord, secretProviderIds } from '../../lib/instances.js';
import { schemaDefaults, validateAgainstSchema } from '../../lib/schema.js';
import { INSTANCE_ROUTES } from './instancesModel.js';
import styles from './Settings.module.css';

export type InstanceEditing = { mode: 'create' } | { mode: 'edit'; instance: InstanceSummary };

export function InstanceEditorDrawer({
  route,
  editing,
  onClose,
}: {
  route: InstanceRoute;
  editing: InstanceEditing;
  onClose: () => void;
}) {
  const copy = INSTANCE_ROUTES[route];
  const types = usePluginTypes(copy.kind);
  const secretProviders = useSecretProviders();
  const secretNames = useSecretNames();
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
              placeholder={copy.namePlaceholder}
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
            secretNames={secretNames}
            disabled={!isAdmin}
          />
        )}
      </div>
    </Drawer>
  );
}
