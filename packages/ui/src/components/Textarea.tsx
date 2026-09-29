import type { Ref, TextareaHTMLAttributes } from 'react';

import { cx } from '../lib/cx.js';
import styles from './controls.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
  changed?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({
  mono,
  invalid,
  changed,
  className,
  rows = 3,
  ref,
  ...rest
}: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid ? true : undefined}
      className={cx(
        styles.input,
        styles.textarea,
        mono && styles.mono,
        changed && styles.changed,
        invalid && styles.invalid,
        className,
      )}
      {...rest}
    />
  );
}
