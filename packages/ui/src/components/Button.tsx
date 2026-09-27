import type { Role } from '@ai-switchboard/core/contract';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';

import { roleRequiredMessage, useCan, useSession } from '../app/session.js';
import { cx } from '../lib/cx.js';
import styles from './Button.module.css';
import { type ButtonVariant, buttonClassName } from './buttonClass.js';
import { Icon, type IconName } from './Icon.js';
import { Spinner } from './Spinner.js';
import { Tooltip } from './Tooltip.js';

export type { ButtonVariant } from './buttonClass.js';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Shows a spinner and blocks clicks. */
  loading?: boolean;
  icon?: IconName;
  /** Full width. */
  block?: boolean;
  /**
   * The role this action needs. Without it the button stays visible but disabled, with a tooltip
   * naming the role (the viewer-role rule).
   */
  requires?: Role;
  /** Why the button is disabled (shown as a tooltip). */
  disabledReason?: string;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
}

/**
 * The button: primary (tangerine gradient + glow), secondary, outline, soft, ghost, danger (coral
 * fill) and danger-outline ("Reset breaker"). Disabled buttons use `aria-disabled` so they stay
 * focusable and can explain themselves in a tooltip.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  block,
  requires,
  disabledReason,
  disabled,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const session = useSession();
  const allowed = useCan(requires ?? 'viewer');
  const roleBlocked = requires != null && !allowed;
  const isDisabled = Boolean(disabled) || roleBlocked || loading;
  const reason = roleBlocked
    ? roleRequiredMessage(requires, session.user?.role)
    : disabled
      ? disabledReason
      : undefined;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };

  const button = (
    <button
      type={type}
      className={cx(buttonClassName(variant, size, block), loading && styles.loading, className)}
      aria-disabled={isDisabled || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'sm' ? 12 : 14} />
      ) : (
        icon && <Icon name={icon} size={14} />
      )}
      {children}
    </button>
  );

  return reason ? <Tooltip content={reason}>{button}</Tooltip> : button;
}
