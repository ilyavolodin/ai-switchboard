import { useMemo } from 'react';

import { usePreviewCron } from '../api/hooks/processes.js';
import { useDebounced } from '../hooks/useDebounced.js';
import { describeCron, formatInZone, timezones } from '../lib/cron.js';
import type { ControlProps } from './controlProps.js';
import styles from './CronField.module.css';
import { Select } from './Select.js';
import { TextField } from './TextField.js';

export interface CronValue {
  cron: string;
  timezone: string;
}

export interface CronFieldProps extends ControlProps<CronValue> {
  /** For a schema field that stores only the cron string. */
  hideTimezone?: boolean;
}

export function CronField({
  value,
  onChange,
  id,
  describedBy,
  invalid: invalidProp,
  hideTimezone,
  disabled,
}: CronFieldProps) {
  // Debounce the strings, not `value`: callers often pass a fresh object every render, which
  // would restart the timer on each one.
  const cron = useDebounced(value.cron, 400);
  const timezone = useDebounced(value.timezone, 400);
  const preview = usePreviewCron(cron.trim() ? { cron: cron.trim(), timezone } : null);
  const empty = value.cron.trim() === '';
  // A preview answers the debounced text; while it catches up, nothing is flagged.
  const answer =
    !empty && cron === value.cron && !preview.isPlaceholderData ? preview.data : undefined;
  const invalid = answer?.valid === false || invalidProp === true;
  const description = describeCron(value.cron) ?? (answer?.valid ? answer.description : null);
  const zones = useMemo(() => timezones(), []);
  const zoneOptions = useMemo(() => {
    const list =
      zones.includes(value.timezone) || !value.timezone ? zones : [value.timezone, ...zones];
    return list.map((z) => ({ value: z, label: z }));
  }, [zones, value.timezone]);
  const next = answer?.valid ? answer.next.slice(0, 3) : [];

  return (
    <div className={styles.wrap}>
      <div className={styles.inputs}>
        <TextField
          id={id}
          aria-describedby={describedBy}
          aria-label={id ? undefined : 'Cron expression'}
          mono
          size="sm"
          className={styles.cron}
          value={value.cron}
          placeholder="0 7 * * *"
          invalid={invalid}
          disabled={disabled}
          onChange={(e) => {
            onChange({ ...value, cron: e.target.value });
          }}
        />
        {!hideTimezone && (
          <Select
            size="sm"
            aria-label="Timezone"
            className={styles.tz}
            options={zoneOptions}
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => {
              onChange({ ...value, timezone: e.target.value });
            }}
          />
        )}
      </div>
      <div className={styles.preview} aria-live="polite">
        {empty ? (
          <span className={styles.error}>Enter a cron expression, e.g. 0 7 * * *</span>
        ) : invalid ? (
          <span className={styles.error}>{answer?.error ?? 'Invalid cron expression'}</span>
        ) : (
          description && <span className={styles.description}>{description}</span>
        )}
        {next.length > 0 && (
          <ul className={styles.next} aria-label="Next three runs">
            {next.map((t) => (
              <li key={t}>{formatInZone(t, value.timezone || 'UTC')}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
