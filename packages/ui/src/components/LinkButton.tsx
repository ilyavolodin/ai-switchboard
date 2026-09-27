import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

import { cx } from '../lib/cx.js';
import { type ButtonVariant, buttonClassName } from './buttonClass.js';
import { Icon, type IconName } from './Icon.js';

export interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  children?: ReactNode;
}

/** A router link styled as a button (navigation, not an action: "New process", "Edit"). */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link className={cx(buttonClassName(variant, size), className)} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </Link>
  );
}
