import type { ReactNode } from 'react';

import { Field } from '../../components/Field.js';
import { TextField, type TextFieldProps } from '../../components/TextField.js';

export type TextRowProps = Omit<
  TextFieldProps,
  'id' | 'aria-describedby' | 'invalid' | 'onChange' | 'value' | 'changed'
> & {
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  help?: ReactNode;
  error?: string | null;
  changed?: boolean;
  /** Rendered after the input, inside the field (e.g. a `<datalist>`). */
  after?: ReactNode;
};

/** A row-layout field holding one text input. */
export function TextRow({ label, help, error, changed, onChange, after, ...input }: TextRowProps) {
  return (
    <Field label={label} help={help} error={error} changed={changed} layout="row">
      {({ id, describedBy, invalid }) => (
        <>
          <TextField
            {...input}
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          {after}
        </>
      )}
    </Field>
  );
}
