import { useMemo } from 'react';

import { usePreviewCron } from '../api/hooks/processes.js';
import { useDebounced } from '../hooks/useDebounced.js';
import { describeCron, formatInZone, timezones } from '../lib/cron.js';
import styles from './CronField.module.css';
import { Select } from './Select.js';
import { TextField } from './TextField.js';

/** A cron schedule and the timezone it fires in. */
export interface CronValue {
  cron: string;
  timezone: string;
}

export interface CronFieldProps {
  value: CronValue;
  onChange: (next: CronValue) => void;
  /** Id for the cron input (from `<Field>`). */
  id?: string;
  describedBy?: string;
  /** Hide the timezone select (when a schema field stores only the cron string). */
  hideTimezone?: boolean;
  disabled?: boolean;
}

/**
 * A cron input with a plain-language preview (cronstrue, instant) and the next three fire times
 * from `POST /processes/preview/cron` in the chosen timezone.
 */
export function CronField({
  value,
  onChange,
  id,
  describedBy,
  hideTimezone,
  disabled,
}: CronFieldProps) {
  const described = describeCron(value.cron);
  const debounced = useDebounced(value, 400);
  const preview = usePreviewCron(
    describeCron(debounced.cron).ok
      ? { cron: debounced.cron.trim(), timezone: debounced.timezone }
      : null,
  );
  const zones = useMemo(() => timezones(), []);
  const zoneOptions = useMemo(() => {
    const list =
      zones.includes(value.timezone) || !value.timezone ? zones : [value.timezone, ...zones];
    return list.map((z) => ({ value: z, label: z }));
  }, [zones, value.timezone]);
  const next = described.ok && preview.data?.valid ? preview.data.next.slice(0, 3) : [];

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
          invalid={!described.ok && value.cron.trim() !== ''}
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
        {described.ok ? (
          <span className={styles.description}>{described.text}</span>
        ) : (
          <span className={styles.error}>{described.error}</span>
        )}
        {preview.data && !preview.data.valid && preview.data.error && (
          <span className={styles.error}>{preview.data.error}</span>
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
