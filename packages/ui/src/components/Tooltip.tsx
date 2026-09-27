import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from 'react';

import { cx } from '../lib/cx.js';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  /** The tip. Kept in the DOM (hidden) so it is the trigger's accessible description. */
  content: ReactNode;
  /** One focusable element (a button or link). */
  children: ReactElement;
  placement?: 'top' | 'bottom' | 'right';
}

/**
 * A small inverse-surface tip on hover and keyboard focus, wired as `aria-describedby`. Used for
 * absolute times, truncated names, and role-disabled controls ("needs the Operator role").
 */
export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const only = Children.only(children);
  const trigger = isValidElement<{ 'aria-describedby'?: string }>(only)
    ? cloneElement(only, {
        'aria-describedby': [only.props['aria-describedby'], id].filter(Boolean).join(' '),
      })
    : only;
  return (
    <span
      className={styles.wrap}
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
      onFocus={() => {
        setOpen(true);
      }}
      onBlur={() => {
        setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cx(
          styles.tip,
          placement === 'bottom' && styles.bottom,
          placement === 'right' && styles.right,
          open && styles.open,
        )}
      >
        {content}
      </span>
    </span>
  );
}
