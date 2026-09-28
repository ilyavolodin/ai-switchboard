import type { ReactNode } from 'react';

import { Field } from '../../components/Field.js';
import { TextField } from '../../components/TextField.js';
import { parseNumber } from '../../lib/instances.js';

export interface CapFieldProps {
  label: string;
  help?: ReactNode;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  /** Unit after the input ("events", "seconds"). */
  suffix?: ReactNode;
  min?: number;
  max?: number;
  placeholder?: string;
  changed?: boolean;
  disabled?: boolean;
  layout?: 'stack' | 'row';
}

/** A core cap: an optional whole number with its unit; empty means "no cap". */
export function CapField({
  label,
  help,
  value,
  onChange,
  suffix,
  min = 0,
  max,
  placeholder = 'no cap',
  changed,
  disabled,
  layout = 'row',
}: CapFieldProps) {
  return (
    <Field label={label} help={help} changed={changed} disabled={disabled} layout={layout}>
      {({ id, describedBy }) => (
        <TextField
          id={id}
          aria-describedby={describedBy}
          type="number"
          inputMode="numeric"
          size="sm"
          mono
          min={min}
          max={max}
          placeholder={placeholder}
          value={value ?? ''}
          changed={changed}
          disabled={disabled}
          suffix={suffix}
          onChange={(e) => {
            onChange(parseNumber(e.target.value));
          }}
        />
      )}
    </Field>
  );
}
