import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { Textarea } from '../../components/Textarea.js';
import { TextField } from '../../components/TextField.js';
import { Toggle } from '../../components/Toggle.js';
import type { SectionProps } from './sectionProps.js';
import styles from './ProcessEditor.module.css';

export function BasicsFields({
  doc,
  baseline,
  set,
  errors,
  disabled,
  isNew,
}: SectionProps & { isNew: boolean }) {
  return (
    <Card className={styles.basics} aria-label="Basics">
      <Field
        label="Name"
        required
        layout="row"
        error={errors['/name']}
        changed={doc.name !== baseline.name}
      >
        {({ id, describedBy, invalid }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            size="sm"
            value={doc.name}
            placeholder="e.g. Autofix"
            disabled={disabled}
            onChange={(e) => {
              const name = e.target.value;
              set((d) => ({ ...d, name }));
            }}
          />
        )}
      </Field>
      <Field label="Description" layout="row" changed={doc.description !== baseline.description}>
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            value={doc.description}
            placeholder="What it does and what it never does"
            disabled={disabled}
            onChange={(e) => {
              const description = e.target.value;
              set((d) => ({ ...d, description }));
            }}
          />
        )}
      </Field>
      <Field
        label="Enabled"
        layout="row"
        changed={!isNew && doc.enabled !== baseline.enabled}
        help={
          doc.enabled
            ? 'on = its triggers and sweeps start runs'
            : 'off = saved, but no event or sweep starts it (events show "process is disabled")'
        }
      >
        {({ id }) => (
          <Toggle
            id={id}
            ariaLabel={isNew ? 'Enabled after saving' : 'Enabled'}
            checked={doc.enabled}
            requires="operator"
            disabled={disabled}
            onChange={(enabled) => {
              set((d) => ({ ...d, enabled }));
            }}
          />
        )}
      </Field>
    </Card>
  );
}
