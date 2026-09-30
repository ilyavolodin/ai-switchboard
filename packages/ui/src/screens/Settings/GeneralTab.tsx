import type { GlobalSettings } from '@ai-switchboard/core/contract';

import { useNotifiers, useSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Field } from '../../components/Field.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { QuietHoursBar } from '../../components/QuietHoursBar.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Toggle } from '../../components/Toggle.js';
import styles from './Settings.module.css';
import { SettingsFormCard } from './SettingsFormCard.js';
import { checkGeneral, generalDraft, generalForm, timezones } from './settingsForm.js';
import { TextRow } from './TextRow.js';
import { useSettingsSection } from './useSettingsSection.js';

export function GeneralTab() {
  const settings = useSettings();
  return (
    <QueryBoundary
      query={settings}
      errorTitle="Settings could not load"
      pending={<Skeleton shape="card" height={320} label="Loading settings" />}
    >
      {(saved) => <GeneralForm saved={saved} />}
    </QueryBoundary>
  );
}

const TZ_LIST_ID = 'settings-timezones';

function GeneralForm({ saved }: { saved: GlobalSettings }) {
  const isAdmin = useCan('admin');
  const notifiers = useNotifiers();
  const base = generalDraft(saved);
  const section = useSettingsSection({
    form: generalForm(base),
    check: (form) => checkGeneral(base, form),
    prompt: {
      title: 'Save general settings?',
      consequence: 'Applies to every process that uses the defaults, from the next decision on.',
      confirmLabel: 'Save settings',
    },
    successMessage: 'Settings saved',
  });
  const { draft, errors, set } = section;

  return (
    <SettingsFormCard
      title="General"
      subtitle="defaults every process and source falls back to"
      section={section}
      unsavedSummary="Unsaved general settings"
    >
      <TextRow
        label="Timezone"
        help="Cron schedules, quiet hours and daily budgets use this timezone unless a process sets its own."
        changed={draft.timezone.trim() !== base.timezone}
        error={errors.timezone}
        mono
        list={TZ_LIST_ID}
        value={draft.timezone}
        disabled={!isAdmin}
        onChange={(timezone) => {
          set({ timezone });
        }}
        after={
          <datalist id={TZ_LIST_ID}>
            {timezones().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        }
      />
      <Field
        label="Default quiet hours"
        layout="row"
        help="Event batches are held during quiet hours; the next sweep does the work. A process can override them."
        changed={JSON.stringify(draft.quiet) !== JSON.stringify(base.defaultQuietHours)}
      >
        {() => (
          <QuietHoursBar
            value={draft.quiet ?? undefined}
            disabled={!isAdmin}
            onChange={(next) => {
              set({ quiet: next ? { start: next.start, end: next.end, days: next.days } : null });
            }}
          />
        )}
      </Field>
      <TextRow
        label="Meter staleness"
        help="A meter reading older than this greys its gauge; budget checks treat it as unknown."
        changed={draft.staleness.trim() !== String(base.meterStalenessMinutes)}
        error={errors.staleness}
        inputMode="numeric"
        className={styles.narrow}
        suffix="minutes"
        value={draft.staleness}
        disabled={!isAdmin}
        onChange={(staleness) => {
          set({ staleness });
        }}
      />
      <TextRow
        label="Source silence"
        help="A source with no event for this long shows on the Board as silent."
        changed={draft.silence.trim() !== String(base.sourceSilenceMinutes)}
        error={errors.silence}
        inputMode="numeric"
        className={styles.narrow}
        suffix="minutes"
        value={draft.silence}
        disabled={!isAdmin}
        onChange={(silence) => {
          set({ silence });
        }}
      />
      <Field
        label="System notifier"
        layout="row"
        help="Breakers, unhealthy instances and stale meters are posted here."
        changed={draft.notifier !== (base.systemNotifierId ?? '')}
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={draft.notifier}
            disabled={!isAdmin}
            placeholder="None"
            options={(notifiers.data ?? []).map((n) => ({ value: n.id, label: n.name }))}
            onChange={(e) => {
              set({ notifier: e.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label="Require a reason for every change"
        layout="row"
        help={
          draft.requireReasons
            ? 'Every change asks for a one-line reason, recorded in the audit log. The API refuses a change without one.'
            : 'Changes save without a prompt and are audited as “(no reason given)”; destructive actions still ask to confirm, with an optional note. The audit log still records who changed what, and when.'
        }
        changed={draft.requireReasons !== base.requireReasons}
      >
        {({ id, describedBy }) => (
          <Toggle
            id={id}
            describedBy={describedBy}
            value={draft.requireReasons}
            requires="admin"
            onChange={(requireReasons) => {
              set({ requireReasons });
            }}
          />
        )}
      </Field>
    </SettingsFormCard>
  );
}
