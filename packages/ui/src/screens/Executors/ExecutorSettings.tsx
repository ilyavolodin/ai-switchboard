import type { ExecutorCapsDTO, ExecutorDetail } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useDeleteExecutor, useSecretProviders, useUpdateExecutor } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { sameValue, secretProviderIds, withoutUndefined } from '../../lib/instances.js';
import { validateAgainstSchema } from '../../lib/schema.js';
import styles from '../Sources/forms.module.css';
import { ExecutorCapsFields } from './ExecutorCapsFields.js';
import { estimatedMeters } from './executorModel.js';

/**
 * The executor's Settings tab: the plugin's schema form, the core's caps (runs, usage per day,
 * meter poll, staleness, estimated limits) and a save bar that asks for a reason.
 */
export function ExecutorSettings({ executor }: { executor: ExecutorDetail }) {
  const navigate = useNavigate();
  const secretProviders = useSecretProviders();
  const [name, setName] = useState(executor.name);
  const [settings, setSettings] = useState(executor.settings);
  const [caps, setCaps] = useState<ExecutorCapsDTO>(executor.caps);
  const [attempted, setAttempted] = useState(false);

  const save = useReasonedMutation(
    useUpdateExecutor(),
    {
      title: `Save ${executor.name}?`,
      consequence:
        'The live plugin object is re-created with the new settings; runs already started keep being tracked. New caps apply to the next budget check.',
      confirmLabel: 'Save changes',
    },
    { successMessage: 'Settings saved' },
  );
  const remove = useReasonedMutation(
    useDeleteExecutor(),
    {
      title: `Delete ${executor.name}?`,
      consequence:
        executor.processes.length > 0
          ? `${executor.processes.map((p) => p.name).join(', ')} lose their executor and hold every batch until they are bound to another one.`
          : 'It disappears from the Board and the capacity strip. Its run history stays until retention removes it.',
      confirmLabel: 'Delete executor',
      danger: true,
    },
    { successMessage: `${executor.name} deleted` },
  );

  const changes = [
    name !== executor.name,
    !sameValue(settings, executor.settings),
    !sameValue(withoutUndefined(caps), withoutUndefined(executor.caps)),
  ].filter(Boolean).length;
  const errors = validateAgainstSchema(executor.settingsSchema, settings);
  const invalid = Object.keys(errors).length > 0 || name.trim() === '';

  const discard = () => {
    setName(executor.name);
    setSettings(executor.settings);
    setCaps(executor.caps);
    setAttempted(false);
  };
  const submit = async () => {
    if (invalid) {
      setAttempted(true);
      return;
    }
    await save.run({
      id: executor.id,
      name: name.trim(),
      settings,
      caps: withoutUndefined(caps),
    });
  };

  return (
    <>
      <Card title="Settings" subtitle={`${executor.typeName} plugin settings`}>
        <Field
          label="Name"
          required
          layout="row"
          changed={name !== executor.name}
          error={attempted && name.trim() === '' ? 'Required' : null}
        >
          {({ id, describedBy, invalid: bad }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={bad}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <SchemaForm
          schema={executor.settingsSchema}
          value={settings}
          onChange={setSettings}
          baseline={executor.settings}
          secretStatus={executor.secretRefs}
          secretProviders={secretProviderIds(secretProviders.data)}
          showAllErrors={attempted}
          layout="row"
        />
      </Card>
      <ExecutorCapsFields
        value={caps}
        onChange={setCaps}
        baseline={executor.caps}
        usage={executor.usage}
        estimated={estimatedMeters(executor.meterSpecs, executor.meters)}
        hasMeters={executor.meterSpecs.length > 0}
      />
      {attempted && invalid && (
        <Banner tone="error" title="Some fields need attention">
          Fix the highlighted fields, then save.
        </Banner>
      )}
      <div className={styles.saveBar} role="region" aria-label="Save settings">
        <span>
          {changes === 0
            ? 'No unsaved changes'
            : `${changes} unsaved change${changes === 1 ? '' : 's'}`}
        </span>
        <span className={styles.spacer} />
        <Button variant="ghost" disabled={changes === 0} onClick={discard}>
          Discard
        </Button>
        <Button
          variant="primary"
          requires="operator"
          disabled={changes === 0}
          disabledReason="Nothing to save"
          loading={save.pending}
          onClick={() => void submit()}
        >
          Save
        </Button>
      </div>
      <Card title="Delete this executor">
        <div className={styles.dangerZone}>
          <span className={styles.spacer}>
            Deleting removes the instance. Processes bound to it hold their batches until they are
            bound to another executor.
          </span>
          <Button
            variant="danger-outline"
            icon="trash"
            requires="operator"
            loading={remove.pending}
            onClick={() =>
              void remove.run({ id: executor.id }).then((r) => {
                if (r !== null) void navigate('/executors');
              })
            }
          >
            Delete executor
          </Button>
        </div>
      </Card>
    </>
  );
}
