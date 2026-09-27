import type { QuietWindow } from '@ai-switchboard/core/contract';

import { cx } from '../lib/cx.js';
import { formatDays } from '../lib/format.js';
import { isQuietHour } from '../lib/quiet.js';
import { Button } from './Button.js';
import { FilterChips } from './FilterChips.js';
import styles from './QuietHoursBar.module.css';
import { TextField } from './TextField.js';

export interface QuietHoursBarProps {
  /** `undefined` = no quiet hours. */
  value: QuietWindow | undefined;
  /** Omit for a read-only bar. */
  onChange?: (next: QuietWindow | undefined) => void;
  disabled?: boolean;
}

const DAY_CHIPS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => ({
  value: String(i + 1),
  label,
}));

/**
 * Quiet hours as a 24-hour bar (sky = quiet), editable with start/end times and weekdays.
 * During quiet hours event batches are held; the next sweep does the work.
 */
export function QuietHoursBar({ value, onChange, disabled }: QuietHoursBarProps) {
  const editable = onChange != null && !disabled;
  const summary = value
    ? `quiet ${value.start}–${value.end} · ${formatDays(value.days)}${value.timezone ? ` · ${value.timezone}` : ''}`
    : 'no quiet hours';
  return (
    <div className={styles.wrap}>
      <div className={styles.bar} role="img" aria-label={`Quiet hours: ${summary}`}>
        {Array.from({ length: 24 }, (_, h) => (
          <span
            key={h}
            data-hour={h}
            data-quiet={value && isQuietHour(h, value) ? 'true' : undefined}
            className={cx(styles.hour, value && isQuietHour(h, value) && styles.quiet)}
            title={`${String(h).padStart(2, '0')}:00`}
          />
        ))}
      </div>
      <div className={styles.ticks} aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
      </div>
      {editable ? (
        <div className={styles.controls}>
          {value ? (
            <>
              <label>
                from{' '}
                <TextField
                  size="sm"
                  type="time"
                  className={styles.time}
                  value={value.start}
                  aria-label="Quiet hours start"
                  onChange={(e) => {
                    onChange({ ...value, start: e.target.value });
                  }}
                />
              </label>
              <label>
                to{' '}
                <TextField
                  size="sm"
                  type="time"
                  className={styles.time}
                  value={value.end}
                  aria-label="Quiet hours end"
                  onChange={(e) => {
                    onChange({ ...value, end: e.target.value });
                  }}
                />
              </label>
              <FilterChips
                label="Days quiet hours apply"
                chips={DAY_CHIPS}
                selected={(value.days ?? [1, 2, 3, 4, 5, 6, 7]).map(String)}
                onToggle={(d) => {
                  const current = value.days ?? [1, 2, 3, 4, 5, 6, 7];
                  const n = Number(d);
                  const next = current.includes(n)
                    ? current.filter((x) => x !== n)
                    : [...current, n].sort();
                  const { days: _drop, ...rest } = value;
                  onChange(next.length === 7 ? rest : { ...rest, days: next });
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onChange(undefined);
                }}
              >
                Remove quiet hours
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              icon="plus"
              onClick={() => {
                onChange({ start: '22:00', end: '07:00' });
              }}
            >
              Add quiet hours
            </Button>
          )}
        </div>
      ) : (
        <span className={styles.summary}>{summary}</span>
      )}
    </div>
  );
}
