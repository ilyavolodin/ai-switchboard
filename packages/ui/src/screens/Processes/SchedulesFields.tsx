import type { ProcessDocument } from '@ai-switchboard/core/contract';

import { CronField } from '../../components/CronField.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Toggle } from '../../components/Toggle.js';
import { AddItemButton } from './AddItemButton.js';
import { newSchedule, removeAt, updateAt } from './editorModel.js';
import styles from './ProcessEditor.module.css';
import { RepeatableItem } from './RepeatableItem.js';
import type { SectionProps } from './sectionProps.js';

type Schedule = ProcessDocument['schedules'][number];

export function SchedulesFields({
  doc,
  baseline,
  set,
  errors,
  disabled,
  timezone,
}: SectionProps & { timezone: string }) {
  const put = (i: number, patch: Partial<Schedule>) => {
    set((d) => ({ ...d, schedules: updateAt(d.schedules, i, patch) }));
  };
  const savedOf = (id: string) => baseline.schedules.find((s) => s.id === id);
  return (
    <div className={styles.stack}>
      {doc.schedules.length === 0 && (
        <p className="t-caption">
          No sweeps. A sweep runs the process on a schedule even without events — the input mapping
          sees <span className="mono">mode = &quot;sweep&quot;</span>.
        </p>
      )}
      {doc.schedules.map((s, i) => {
        const saved = savedOf(s.id);
        return (
          <RepeatableItem
            key={s.id}
            label={`Schedule ${i + 1}`}
            overline={`sweep ${i + 1}`}
            disabled={disabled}
            onRemove={() => {
              set((d) => ({ ...d, schedules: removeAt(d.schedules, i) }));
            }}
            lead={
              <Toggle
                size="sm"
                ariaLabel={`Schedule ${i + 1} enabled`}
                value={s.enabled}
                disabled={disabled}
                onChange={(enabled) => {
                  put(i, { enabled });
                }}
              />
            }
          >
            <Field
              label="Cron"
              layout="row"
              error={errors[`/schedules/${i}/cron`]}
              changed={saved != null && (saved.cron !== s.cron || saved.timezone !== s.timezone)}
            >
              {({ id, describedBy }) => (
                <CronField
                  id={id}
                  describedBy={describedBy}
                  value={{ cron: s.cron, timezone: s.timezone }}
                  disabled={disabled}
                  onChange={(v) => {
                    put(i, v);
                  }}
                />
              )}
            </Field>
            <Field
              label="Catch-up"
              help="what to do with ticks missed while no replica was running"
              layout="row"
              changed={saved != null && saved.catchUp !== s.catchUp}
            >
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  size="sm"
                  value={s.catchUp}
                  disabled={disabled}
                  options={[
                    { value: 'skip', label: 'skip missed ticks' },
                    { value: 'once', label: 'run once for missed ticks' },
                  ]}
                  onChange={(e) => {
                    put(i, { catchUp: e.target.value === 'once' ? 'once' : 'skip' });
                  }}
                />
              )}
            </Field>
          </RepeatableItem>
        );
      })}
      <AddItemButton
        disabled={disabled}
        onClick={() => {
          set((d) => ({ ...d, schedules: [...d.schedules, newSchedule(d.schedules, timezone)] }));
        }}
      >
        Add schedule
      </AddItemButton>
    </div>
  );
}
