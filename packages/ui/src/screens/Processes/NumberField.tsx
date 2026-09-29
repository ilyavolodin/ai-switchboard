import { type ReactNode, useState } from 'react';

import { TextField } from '../../components/TextField.js';
import { parseCap } from './editorModel.js';

export interface NumberFieldProps {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  id?: string;
  describedBy?: string;
  ariaLabel?: string;
  suffix?: ReactNode;
  placeholder?: string;
  /** Clearing is allowed and means "none" (caps); otherwise a number is required. */
  optional?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  changed?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

function format(v: number | undefined): string {
  return v == null ? '' : String(v);
}

/**
 * Keeps what the person typed while it is incomplete ("", "1.") and only reports valid numbers.
 * Accepts "400k" / "1.2M".
 */
export function NumberField({
  value,
  onChange,
  id,
  describedBy,
  ariaLabel,
  suffix,
  placeholder,
  optional,
  integer,
  min = 0,
  max,
  changed,
  invalid,
  disabled,
  className,
}: NumberFieldProps) {
  const [text, setText] = useState(() => format(value));
  const [synced, setSynced] = useState(value);
  // Adopt a new value from outside (discard, restore) unless it is what the text already says.
  if (value !== synced) {
    setSynced(value);
    if (parseCap(text) !== value) setText(format(value));
  }
  const parsed = parseCap(text);
  const bad =
    parsed === undefined
      ? !optional
      : !Number.isFinite(parsed) ||
        parsed < min ||
        (max != null && parsed > max) ||
        (integer === true && !Number.isInteger(parsed));

  return (
    <TextField
      id={id}
      aria-describedby={describedBy}
      aria-label={id ? undefined : ariaLabel}
      inputMode="decimal"
      size="sm"
      mono
      className={className}
      value={text}
      placeholder={placeholder}
      suffix={suffix}
      changed={changed}
      invalid={invalid === true || bad}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const n = parseCap(next);
        const ok =
          n === undefined
            ? optional === true
            : Number.isFinite(n) &&
              n >= min &&
              (max == null || n <= max) &&
              (integer !== true || Number.isInteger(n));
        if (ok) {
          setSynced(n);
          onChange(n);
        }
      }}
    />
  );
}
