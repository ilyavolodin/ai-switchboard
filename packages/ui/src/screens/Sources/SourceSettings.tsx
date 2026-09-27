import type { SourceCapsDTO, SourceDetail } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useDeleteSource, useSecretProviders, useUpdateSource } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { sameValue, secretProviderIds, withoutUndefined } from '../../lib/instances.js';
import { validateAgainstSchema } from '../../lib/schema.js';
import styles from './forms.module.css';
import { SourceCapsFields } from './SourceCapsFields.js';

/**
 * The source's Settings tab: the plugin's schema form, the core's caps and mute list, and a save
 * bar that asks for a reason. Delete lives at the bottom.
 */
export function SourceSettings({ source }: { source: SourceDetail }) {
  const navigate = useNavigate();
  const secretProviders = useSecretProviders();
  const [name, setName] = useState(source.name);
  const [settings, setSettings] = useState(source.settings);
  const [caps, setCaps] = useState<SourceCapsDTO>(source.caps);
  const [attempted, setAttempted] = useState(false);

  const save = useReasonedMutation(
    useUpdateSource(),
    {
      title: `Save ${source.name}?`,
      consequence:
        'The live plugin object is re-created with the new settings; deliveries in flight finish first.',
      confirmLabel: 'Save changes',
    },
    { successMessage: 'Settings saved' },
  );
  const remove = useReasonedMutation(
    useDeleteSource(),
    {
      title: `Delete ${source.name}?`,
      consequence:
        source.processes.length > 0
          ? `Its triggers stop matching: ${source.processes.map((p) => p.name).join(', ')} will no longer receive its events. Its webhook URL answers 404.`
          : 'Its webhook URL answers 404 and it disappears from the Board. Recorded events stay until retention removes them.',
      confirmLabel: 'Delete source',
      danger: true,
    },
    { successMessage: `${source.name} deleted` },
  );

  const changes = [
    name !== source.name,
    !sameValue(settings, source.settings),
    !sameValue(withoutUndefined(caps), withoutUndefined(source.caps)),
  ].filter(Boolean).length;
  const errors = validateAgainstSchema(source.settingsSchema, settings);
  const invalid = Object.keys(errors).length > 0 || name.trim() === '';

  const discard = () => {
    setName(source.name);
    setSettings(source.settings);
    setCaps(source.caps);
    setAttempted(false);
  };
  const submit = async () => {
    if (invalid) {
      setAttempted(true);
      return;
    }
    await save.run({
      id: source.id,
      name: name.trim(),
      settings,
      caps: withoutUndefined(caps),
    });
  };

  return (
    <>
      <Card title="Settings" subtitle={`${source.typeName} plugin settings`}>
        <Field
          label="Name"
          required
          layout="row"
          changed={name !== source.name}
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
          schema={source.settingsSchema}
          value={settings}
          onChange={setSettings}
          baseline={source.settings}
          secretStatus={source.secretRefs}
          secretProviders={secretProviderIds(secretProviders.data)}
          showAllErrors={attempted}
          layout="row"
        />
      </Card>
      <SourceCapsFields
        value={caps}
        onChange={setCaps}
        baseline={source.caps}
        eventTypes={source.eventTypes}
        mode={source.mode}
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
      <Card title="Delete this source">
        <div className={styles.dangerZone}>
          <span className={styles.spacer}>
            Deleting removes the instance and its webhook URL. Processes keep their triggers but
            stop matching.
          </span>
          <Button
            variant="danger-outline"
            icon="trash"
            requires="operator"
            loading={remove.pending}
            onClick={() =>
              void remove.run({ id: source.id }).then((r) => {
                if (r !== null) void navigate('/sources');
              })
            }
          >
            Delete source
          </Button>
        </div>
      </Card>
    </>
  );
}
