import type { JSONSchema, SecretRefDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';

import { useSecretProviders } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { TextField } from '../../components/TextField.js';
import { secretProviderIds } from '../../lib/instances.js';
import { validateAgainstSchema } from '../../lib/schema.js';
import type { DeliverySample } from '../../lib/suggest.js';
import styles from '../Sources/forms.module.css';
import {
  editableCaps,
  type InstanceSettingsDraft,
  instanceChangeCount,
} from './instanceSettings.js';
import { unsavedLabel } from './unsavedLabel.js';
import { LeaveGuardDialog } from './LeaveGuardDialog.js';
import { useLeaveGuard } from './useLeaveGuard.js';

/** The saved instance the form edits (a source or a destination detail). */
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
  /** "source" / "destination", for the delete card's copy. */
  kind: 'source' | 'destination';
  /** The core caps block; `baseline` is the saved caps, for the changed markers. */
  renderCaps: (caps: C, onChange: (next: C) => void, disabled: boolean, baseline: C) => ReactNode;
  /**
   * Asks for a reason and saves; resolves to the saved instance as the server returned it, or
   * `null` when cancelled or failed.
   */
  onSave: (draft: InstanceSettingsDraft<C>) => Promise<InstanceSettingsEntity<C> | null>;
  saving: boolean;
  /** Asks for a reason and deletes; resolves `null` when cancelled or failed. */
  onDelete: () => Promise<unknown>;
  deleting: boolean;
  /** What deleting does, under the delete card's title. */
  deleteNote: string;
  /** Where to go once it is deleted (the list). */
  afterDelete: string;
  /** Shown in the delete card when a delete was refused (`<InUseBanner>`). */
  deleteBlocked?: ReactNode;
  /** A sample delivery the schema form's path fields suggest from (push sources). */
  sample?: DeliverySample | null;
  /** Shown under the schema form with the draft settings (the sample-delivery preview). */
  renderAfterSettings?: (settings: Record<string, unknown>) => ReactNode;
}

/**
 * A source's or destination's Settings tab: name and the plugin's schema form, the core's caps, a
 * save bar that asks for a reason, and Delete at the bottom. Viewers see every field disabled.
 * Leaving the tab with unsaved changes asks first. Re-mount it (`key`) per instance.
 */
export function InstanceSettingsForm<C extends object>({
  entity,
  kind,
  renderCaps,
  onSave,
  saving,
  onDelete,
  deleting,
  deleteNote,
  afterDelete,
  deleteBlocked,
  sample,
  renderAfterSettings,
}: InstanceSettingsFormProps<C>) {
  const navigate = useNavigate();
  const canEdit = useCan('operator');
  const secretProviders = useSecretProviders();
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
  const errors = validateAgainstSchema(entity.settingsSchema, settings);
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
    const result = await onDelete();
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
          secretProviders={secretProviderIds(secretProviders.data)}
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
        {deleteBlocked}
        <div className={styles.dangerZone}>
          <span className={styles.spacer}>{deleteNote}</span>
          <Button
            variant="danger-outline"
            icon="trash"
            requires="operator"
            loading={deleting}
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
