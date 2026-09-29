import { cx } from '../lib/cx.js';
import styles from './Button.module.css';

export type ButtonVariant =
  'primary' | 'secondary' | 'outline' | 'soft' | 'ghost' | 'danger' | 'danger-outline';

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  outline: styles.outline,
  soft: styles.soft,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-outline': styles.dangerOutline,
};

export function buttonClassName(
  variant: ButtonVariant,
  size: 'sm' | 'md' | 'lg',
  block?: boolean,
): string {
  return cx(
    styles.button,
    VARIANT_CLASS[variant],
    size === 'sm' && styles.sm,
    size === 'lg' && styles.lg,
    block && styles.block,
  );
}
