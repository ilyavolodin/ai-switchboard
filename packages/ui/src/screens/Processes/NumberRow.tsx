import type { ReactNode } from 'react';

import { Field } from '../../components/Field.js';
import { NumberField, type NumberFieldProps } from './NumberField.js';

type Shared = Omit<NumberFieldProps, 'id' | 'describedBy' | 'onChange' | 'optional' | 'changed'> & {
  label: ReactNode;
  help?: ReactNode;
  changed?: boolean;
  error?: string | null;
};

export type NumberRowProps = Shared &
  (
    | { optional: true; onChange: (next: number | undefined) => void }
    | { optional?: false; onChange: (next: number) => void }
  );

/** A row-layout field holding one number; a required one ignores an empty entry. */
export function NumberRow(props: NumberRowProps) {
  const { label, help, changed, error, optional, onChange: _onChange, ...field } = props;
  return (
    <Field label={label} help={help} layout="row" changed={changed} error={error}>
      {({ id, describedBy }) => (
        <NumberField
          {...field}
          id={id}
          describedBy={describedBy}
          optional={optional}
          onChange={(v) => {
            if (props.optional) props.onChange(v);
            else if (v != null) props.onChange(v);
          }}
        />
      )}
    </Field>
  );
}
