import type { PluginTypeDTO } from '@ai-switchboard/core/contract';
import type { ReactNode } from 'react';

import { useSecretFieldProps } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Field } from '../../components/Field.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { TextField } from '../../components/TextField.js';
import type { DeliverySample } from '../../lib/suggest.js';
import styles from './forms.module.css';

export interface InstanceConfigureStepProps {
  type: PluginTypeDTO;
  noun: string;
  name: string;
  onNameChange: (name: string) => void;
  settings: Record<string, unknown>;
  onSettingsChange: (settings: Record<string, unknown>) => void;
  attempted: boolean;
  invalid: boolean;
  errors: Record<string, string[]>;
  sample?: DeliverySample | null;
  /** Rendered under the settings, e.g. a sample preview. */
  afterSettings?: ReactNode;
  caps?: ReactNode;
}

export function InstanceConfigureStep({
  type,
  noun,
  name,
  onNameChange,
  settings,
  onSettingsChange,
  attempted,
  invalid,
  errors,
  sample,
  afterSettings,
  caps,
}: InstanceConfigureStepProps) {
  const secretFields = useSecretFieldProps(type.settingsSchema);
  return (
    <div className={styles.stack}>
      {type.description && <p className={styles.note}>{type.description}</p>}
      <Field
        label="Name"
        required
        help={`Shown on the Board and in every trace, e.g. "${type.displayName} — acme org".`}
        error={attempted && name.trim() === '' ? 'Required' : null}
      >
        {({ id, describedBy, invalid: bad }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={bad}
            value={name}
            onChange={(e) => {
              onNameChange(e.target.value);
            }}
          />
        )}
      </Field>
      <SchemaForm
        schema={type.settingsSchema}
        value={settings}
        onChange={onSettingsChange}
        showAllErrors={attempted}
        {...secretFields}
        errors={errors}
        sample={sample ?? null}
      />
      {afterSettings}
      {caps}
      {attempted && invalid && (
        <Banner tone="error" title="Some fields need attention">
          Fix the highlighted fields, then create the {noun}.
        </Banner>
      )}
    </div>
  );
}
