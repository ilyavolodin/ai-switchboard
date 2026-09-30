import type { RetentionSettings } from '@ai-switchboard/core/contract';

import { useSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from './Settings.module.css';
import { SettingsFormCard } from './SettingsFormCard.js';
import { checkRetention, retentionForm } from './settingsForm.js';
import { TextRow } from '../../components/TextRow.js';
import { useSettingsSection } from './useSettingsSection.js';

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
  return (
    <QueryBoundary
      query={settings}
      errorTitle="Retention could not load"
      pending={<Skeleton shape="card" height={300} label="Loading retention" />}
    >
      {(s) => <RetentionForm saved={s.retention} />}
    </QueryBoundary>
  );
}

function RetentionForm({ saved }: { saved: RetentionSettings }) {
  const isAdmin = useCan('admin');
  const section = useSettingsSection({
    form: retentionForm(saved),
    check: (form) => checkRetention(saved, form),
    prompt: {
      title: 'Save retention?',
      consequence: 'Rows older than the new limits are deleted at the next nightly prune.',
      confirmLabel: 'Save retention',
      danger: true,
    },
    successMessage: 'Retention saved',
  });

  return (
    <SettingsFormCard
      title="Retention"
      subtitle="days kept before the nightly prune"
      section={section}
      unsavedSummary="Unsaved retention"
      hint="Runs, the audit log and process versions are kept."
    >
      {ROWS.map((r) => (
        <TextRow
          key={r.key}
          label={r.label}
          help={r.help}
          changed={section.draft[r.key].trim() !== String(saved[r.key])}
          error={section.errors[r.key]}
          inputMode="numeric"
          suffix="days"
          className={styles.narrow}
          value={section.draft[r.key]}
          disabled={!isAdmin}
          onChange={(value) => {
            section.set({ [r.key]: value });
          }}
        />
      ))}
    </SettingsFormCard>
  );
}
