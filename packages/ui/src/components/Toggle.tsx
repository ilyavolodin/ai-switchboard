import type { Role } from '@ai-switchboard/core/contract';

import { roleRequiredMessage, useCan, useSession } from '../app/session.js';
import { cx } from '../lib/cx.js';
import styles from './Toggle.module.css';
import { Tooltip } from './Tooltip.js';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** When omitted, `ariaLabel` is required. */
  label?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  boxed?: boolean;
  disabled?: boolean;
  requires?: Role;
  id?: string;
  describedBy?: string;
}

/** Enabling or disabling a process, source or destination goes through a reason prompt. */
export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  size = 'md',
  boxed,
  disabled,
  requires,
  id,
  describedBy,
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
      aria-checked={checked}
      aria-label={label ?? ariaLabel}
      aria-disabled={blocked || undefined}
      className={cx(styles.track, size === 'sm' && styles.sm)}
      onClick={() => {
        if (!blocked) onChange(!checked);
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
