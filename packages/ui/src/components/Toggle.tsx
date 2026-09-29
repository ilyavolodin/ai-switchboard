import type { Role } from '@ai-switchboard/core/contract';

import { roleRequiredMessage, useCan, useSession } from '../app/session.js';
import { cx } from '../lib/cx.js';
import styles from './Toggle.module.css';
import { Tooltip } from './Tooltip.js';
import type { ControlProps } from './controlProps.js';

export interface ToggleProps extends ControlProps<boolean> {
  /** When omitted, `ariaLabel` is required. */
  label?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  boxed?: boolean;
  requires?: Role;
}

/** Enabling or disabling a process, source or destination goes through a reason prompt. */
export function Toggle({
  value,
  onChange,
  label,
  ariaLabel,
  size = 'md',
  boxed,
  disabled,
  requires,
  id,
  describedBy,
  invalid,
}: ToggleProps) {
  const session = useSession();
  const allowed = useCan(requires ?? 'viewer');
  const roleBlocked = requires != null && !allowed;
  const blocked = Boolean(disabled) || roleBlocked;
  const track = (
    <button
      type="button"
      id={id}
      aria-describedby={describedBy}
      role="switch"
      aria-checked={value}
      aria-invalid={invalid === true || undefined}
      aria-label={label ?? ariaLabel}
      aria-disabled={blocked || undefined}
      className={cx(styles.track, size === 'sm' && styles.sm)}
      onClick={() => {
        if (!blocked) onChange(!value);
      }}
    >
      <span className={styles.knob} />
    </button>
  );
  const control = roleBlocked ? (
    <Tooltip content={roleRequiredMessage(requires, session.user?.role)}>{track}</Tooltip>
  ) : (
    track
  );
  return (
    <span className={cx(styles.wrap, boxed && styles.boxed)}>
      {label && (
        <span className={styles.label} aria-hidden="true">
          {label}
        </span>
      )}
      {control}
    </span>
  );
}
