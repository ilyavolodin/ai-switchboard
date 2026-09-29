import type { RetentionSettings } from '@ai-switchboard/core/contract';

import { useSettings, useUpdateSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { QueryError } from '../../components/QueryError.js';
import { Skeleton } from '../../components/Skeleton.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { LeaveGuardDialog } from '../shared/LeaveGuardDialog.js';
import { useSettingsDraft } from '../shared/useSettingsDraft.js';
import styles from './Settings.module.css';
import { changedFields, parsePositiveInt, retentionForm } from './settingsForm.js';

const ROWS: { key: keyof RetentionSettings; label: string; help: string }[] = [
  { key: 'eventsDays', label: 'Events', help: 'Event envelopes and their attributes (Activity).' },
  {
    key: 'rawBodiesDays',
    label: 'Raw bodies',
    help: 'Stored webhook bodies used by Replay. They can hold internal text; keep this short.',
  },
  { key: 'dispatchesDays', label: 'Dispatches, batches', help: 'Filter decisions and batches.' },
  { key: 'meterReadingsDays', label: 'Meter readings', help: 'Meter history bands.' },
  { key: 'statsHourlyDays', label: 'Hourly stats', help: 'Funnels, charts and sparklines.' },
];

export function RetentionTab() {
  const settings = useSettings();
  if (settings.isPending) return <Skeleton shape="card" height={300} label="Loading retention" />;
  if (settings.isError) {
    return <QueryError query={settings} title="Retention could not load" />;
  }
  return <RetentionForm saved={settings.data.retention} />;
}

function RetentionForm({ saved }: { saved: RetentionSettings }) {
  const isAdmin = useCan('admin');
  const form = useSettingsDraft(retentionForm(saved));
  const draft = form.draft;
  const parsed = {} as Record<keyof RetentionSettings, number | null>;
  for (const r of ROWS) parsed[r.key] = parsePositiveInt(draft[r.key]);
  const invalid = ROWS.some((r) => parsed[r.key] == null);
  const next: RetentionSettings = {
    eventsDays: parsed.eventsDays ?? saved.eventsDays,
    rawBodiesDays: parsed.rawBodiesDays ?? saved.rawBodiesDays,
    dispatchesDays: parsed.dispatchesDays ?? saved.dispatchesDays,
    meterReadingsDays: parsed.meterReadingsDays ?? saved.meterReadingsDays,
    statsHourlyDays: parsed.statsHourlyDays ?? saved.statsHourlyDays,
  };
  const dirty = Object.keys(changedFields(saved, next)).length > 0;

  const save = useReasonedMutation(
    useUpdateSettings(),
    {
      title: 'Save retention?',
      consequence: 'Rows older than the new limits are deleted at the next nightly prune.',
      confirmLabel: 'Save retention',
      danger: true,
    },
    { successMessage: 'Retention saved' },
  );

  return (
    <Card title="Retention" subtitle="days kept before the nightly prune">
      <div className={styles.fields}>
        {ROWS.map((r) => (
          <Field
            key={r.key}
            label={r.label}
            layout="row"
            help={r.help}
            changed={parsed[r.key] !== saved[r.key]}
            error={parsed[r.key] == null ? 'Enter a whole number of days' : null}
          >
            {({ id, describedBy, invalid: bad }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={bad}
                inputMode="numeric"
                suffix="days"
                className={styles.narrow}
                value={draft[r.key]}
                disabled={!isAdmin}
                onChange={(e) => {
                  form.set({ [r.key]: e.target.value });
                }}
              />
            )}
          </Field>
        ))}
      </div>
      <p className={styles.hint}>Runs, the audit log and process versions are kept.</p>
      <div className={styles.footer}>
        <Button
          variant="primary"
          requires="admin"
          disabled={!dirty || invalid}
          disabledReason={invalid ? 'Fix the highlighted fields first' : 'Nothing changed'}
          loading={save.pending}
          onClick={() => void save.run({ settings: { retention: next } })}
        >
          Save
        </Button>
      </div>
      <LeaveGuardDialog blocker={form.leaveGuard.blocker} summary="Unsaved retention" />
    </Card>
  );
}
