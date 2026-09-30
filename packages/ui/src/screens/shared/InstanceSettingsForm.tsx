import type { JSONSchema, SecretRefDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';

import { useSecretFieldProps } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { TextField } from '../../components/TextField.js';
import { useSchemaErrors } from '../../hooks/useSchemaErrors.js';
import type { DeliverySample } from '../../lib/suggest.js';
import styles from './forms.module.css';
import {
  editableCaps,
  type InstanceSettingsDraft,
  instanceChangeCount,
} from './instanceSettings.js';
import { unsavedLabel } from './unsavedLabel.js';
import { LeaveGuardDialog } from './LeaveGuardDialog.js';
import type { InstanceDeletion } from './useInstanceDelete.js';
import { useLeaveGuard } from './useLeaveGuard.js';

export interface InstanceSettingsEntity<C> {
  id: string;
  name: string;
  typeName: string;
  settings: Record<string, unknown>;
  settingsSchema: JSONSchema;
  secretRefs: SecretRefDTO[];
  caps: C;
}

export interface InstanceSettingsFormProps<C extends object> {
  entity: InstanceSettingsEntity<C>;
  kind: 'source' | 'destination';
  renderCaps: (caps: C, onChange: (next: C) => void, disabled: boolean, baseline: C) => ReactNode;
  onSave: (draft: InstanceSettingsDraft<C>) => Promise<InstanceSettingsEntity<C> | null>;
  saving: boolean;
  /** From `useInstanceDelete`. */
  deletion: InstanceDeletion;
  deleteNote: string;
  afterDelete: string;
  sample?: DeliverySample | null;
  renderAfterSettings?: (settings: Record<string, unknown>) => ReactNode;
}

/** Re-mount it (`key`) per instance. */
export function InstanceSettingsForm<C extends object>({
  entity,
  kind,
  renderCaps,
  onSave,
  saving,
  deletion,
  deleteNote,
  afterDelete,
  sample,
  renderAfterSettings,
}: InstanceSettingsFormProps<C>) {
  const navigate = useNavigate();
  const canEdit = useCan('operator');
  const secretFields = useSecretFieldProps(entity.settingsSchema);
  const [name, setName] = useState(entity.name);
  const [settings, setSettings] = useState(entity.settings);
  const [caps, setCaps] = useState<C>(entity.caps);
  const [attempted, setAttempted] = useState(false);
  // What the draft is compared against: the instance as last saved or loaded. The server
  // normalises a save (schema defaults filled in, jsonb key order, derived caps), so after a
  // save both the draft and this baseline are reset from its response, not kept from the form.
  const [saved, setSaved] = useState<InstanceSettingsDraft<C>>(entity);
  const [seen, setSeen] = useState(entity);

  const changes = instanceChangeCount({ name, settings, caps }, saved);
  const adopt = (next: InstanceSettingsDraft<C>) => {
    setSaved({ name: next.name, settings: next.settings, caps: next.caps });
    setName(next.name);
    setSettings(next.settings);
    setCaps(next.caps);
    setAttempted(false);
  };
  // A refetch (another tab's save, a reload) replaces a clean form; unsaved edits are kept.
  if (seen !== entity) {
    setSeen(entity);
    if (changes === 0) adopt(entity);
  }
  const leaveGuard = useLeaveGuard(changes > 0);
  const errors = useSchemaErrors(entity.settingsSchema, settings);
  const nameMissing = name.trim() === '';
  const invalid = Object.keys(errors).length > 0 || nameMissing;
  const disabled = !canEdit;

  const discard = () => {
    adopt(saved);
  };
  const submit = async () => {
    if (invalid) {
      setAttempted(true);
      return;
    }
    const result = await onSave({ name: name.trim(), settings, caps: editableCaps(caps) });
    if (result) adopt(result);
  };
  const remove = async () => {
    const result = await deletion.run();
    if (result === null) return;
    leaveGuard.allowNextNavigation();
    void navigate(afterDelete);
  };

  return (
    <>
      <Card title="Settings" subtitle={`${entity.typeName} plugin settings`}>
        <Field
          label="Name"
          required
          layout="row"
          changed={name !== saved.name}
          error={attempted && nameMissing ? 'Required' : null}
        >
          {({ id, describedBy, invalid: bad }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={bad}
              value={name}
              disabled={disabled}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <SchemaForm
          schema={entity.settingsSchema}
          value={settings}
          onChange={setSettings}
          baseline={saved.settings}
          secretStatus={entity.secretRefs}
          {...secretFields}
          errors={errors}
          showAllErrors={attempted}
          disabled={disabled}
          layout="row"
          sample={sample}
        />
        {renderAfterSettings?.(settings)}
      </Card>
      {renderCaps(caps, setCaps, disabled, saved.caps)}
      {attempted && invalid && (
        <Banner tone="error" title="Some fields need attention">
          Fix the highlighted fields, then save.
        </Banner>
      )}
      <div className={styles.saveBar} role="region" aria-label="Save settings">
        <span>{unsavedLabel(changes)}</span>
        <span className={styles.spacer} />
        <Button variant="ghost" disabled={changes === 0} onClick={discard}>
          Discard
        </Button>
        <Button
          variant="primary"
          requires="operator"
          disabled={changes === 0}
          disabledReason="Nothing to save"
          loading={saving}
          onClick={() => void submit()}
        >
          Save
        </Button>
      </div>
      <Card title={`Delete this ${kind}`}>
        {deletion.blocked}
        <div className={styles.dangerZone}>
          <span className={styles.spacer}>{deleteNote}</span>
          <Button
            variant="danger-outline"
            icon="trash"
            requires="operator"
            loading={deletion.pending}
            onClick={() => void remove()}
          >
            Delete {kind}
          </Button>
        </div>
      </Card>
      <LeaveGuardDialog blocker={leaveGuard.blocker} summary={unsavedLabel(changes)} />
    </>
  );
}
