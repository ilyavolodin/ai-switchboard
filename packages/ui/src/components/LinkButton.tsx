import type { Role } from '@ai-switchboard/core/contract';
import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

import { roleRequiredMessage, useCan, useSession } from '../app/session.js';
import { cx } from '../lib/cx.js';
import { type ButtonVariant, buttonClassName } from './buttonClass.js';
import { Icon, type IconName } from './Icon.js';
import { Tooltip } from './Tooltip.js';

export interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  /** Like `Button`: without this role the link stays visible but goes nowhere, and says why. */
  requires?: Role;
  children?: ReactNode;
}

/** For navigation, not actions. */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  requires,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  const session = useSession();
  const allowed = useCan(requires ?? 'viewer');
  const classes = cx(buttonClassName(variant, size), className);
  const content = (
    <>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </>
  );
  if (requires != null && !allowed) {
    // No `href`, so nothing follows it; `tabIndex` keeps it focusable for the tooltip.
    return (
      <Tooltip content={roleRequiredMessage(requires, session.user?.role)}>
        <a role="link" tabIndex={0} aria-disabled="true" className={classes}>
          {content}
        </a>
      </Tooltip>
    );
  }
  return (
    <Link className={classes} {...rest}>
      {content}
    </Link>
  );
}
