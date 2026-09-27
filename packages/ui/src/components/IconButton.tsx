import type { Role } from '@ai-switchboard/core/contract';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';

import { roleRequiredMessage, useCan, useSession } from '../app/session.js';
import { cx } from '../lib/cx.js';
import { Icon, type IconName } from './Icon.js';
import styles from './IconButton.module.css';
import { Tooltip } from './Tooltip.js';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-label'
> {
  icon: IconName;
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'outline' | 'ghost';
  requires?: Role;
}

/** An icon-only button (back, copy, close, theme). Always labelled; the label is the tooltip. */
export function IconButton({
  icon,
  label,
  size = 'sm',
  variant = 'outline',
  requires,
  disabled,
  className,
  onClick,
  ...rest
}: IconButtonProps) {
  const session = useSession();
  const allowed = useCan(requires ?? 'viewer');
  const blocked = Boolean(disabled) || (requires != null && !allowed);
  const tip =
    requires != null && !allowed
      ? `${label} · ${roleRequiredMessage(requires, session.user?.role)}`
      : label;
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={blocked || undefined}
        className={cx(
          styles.iconButton,
          size === 'md' && styles.md,
          variant === 'ghost' && styles.ghost,
          className,
        )}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          if (blocked) return;
          onClick?.(e);
        }}
        {...rest}
      >
        <Icon name={icon} size={14} />
      </button>
    </Tooltip>
  );
}
