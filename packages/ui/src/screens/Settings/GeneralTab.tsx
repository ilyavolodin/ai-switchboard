import type { GlobalSettings } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useNotifiers, useSettings, useUpdateSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { QuietHoursBar } from '../../components/QuietHoursBar.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { TextField } from '../../components/TextField.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import styles from './Settings.module.css';
import { changedFields, generalDraft, parsePositiveInt, timezones } from './settingsForm.js';

/**
 * General: installation timezone, default quiet hours, staleness and silence, system notifier,
 * and whether every change must carry a reason.
 */
export function GeneralTab() {
  const settings = useSettings();
  if (settings.isPending) return <Skeleton shape="card" height={320} label="Loading settings" />;
  if (settings.isError) {
    return (
      <Banner tone="error" title="Settings could not load">
        {errorMessage(settings.error)}
      </Banner>
    );
  }
  // Re-mount the form when the saved settings change so it starts from what is stored.
  return <GeneralForm key={JSON.stringify(generalDraft(settings.data))} saved={settings.data} />;
}

const TZ_LIST_ID = 'settings-timezones';

function GeneralForm({ saved }: { saved: GlobalSettings }) {
  const isAdmin = useCan('admin');
  const notifiers = useNotifiers();
  const base = generalDraft(saved);
  const [timezone, setTimezone] = useState(base.timezone);
  const [quiet, setQuiet] = useState(base.defaultQuietHours);
  const [staleness, setStaleness] = useState(String(base.meterStalenessMinutes));
  const [silence, setSilence] = useState(String(base.sourceSilenceMinutes));
  const [notifier, setNotifier] = useState(base.systemNotifierId ?? '');
  const [requireReasons, setRequireReasons] = useState(base.requireReasons);

  const stalenessN = parsePositiveInt(staleness);
  const silenceN = parsePositiveInt(silence);
  const invalid = stalenessN == null || silenceN == null || timezone.trim() === '';
  const changes = changedFields(base, {
    timezone: timezone.trim(),
    defaultQuietHours: quiet,
    meterStalenessMinutes: stalenessN ?? base.meterStalenessMinutes,
    sourceSilenceMinutes: silenceN ?? base.sourceSilenceMinutes,
    systemNotifierId: notifier === '' ? null : notifier,
    requireReasons,
  });
  const dirty = Object.keys(changes).length > 0;

  const save = useReasonedMutation(
    useUpdateSettings(),
    {
      title: 'Save general settings?',
      consequence: 'Applies to every process that uses the defaults, from the next decision on.',
      confirmLabel: 'Save settings',
    },
    { successMessage: 'Settings saved' },
  );

  return (
    <Card title="General" subtitle="defaults every process and source falls back to">
      <div className={styles.fields}>
        <Field
          label="Timezone"
          layout="row"
          help="Cron schedules, quiet hours and daily budgets use this timezone unless a process sets its own."
          changed={timezone.trim() !== base.timezone}
          error={timezone.trim() === '' ? 'A timezone is required' : null}
        >
          {({ id, describedBy, invalid: bad }) => (
            <>
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={bad}
                mono
                list={TZ_LIST_ID}
                value={timezone}
                disabled={!isAdmin}
                onChange={(e) => {
                  setTimezone(e.target.value);
                }}
              />
              <datalist id={TZ_LIST_ID}>
                {timezones().map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field
          label="Default quiet hours"
          layout="row"
          help="Event batches are held during quiet hours; the next sweep does the work. A process can override them."
          changed={JSON.stringify(quiet) !== JSON.stringify(base.defaultQuietHours)}
        >
          {() => (
            <QuietHoursBar
              value={quiet ?? undefined}
              disabled={!isAdmin}
              onChange={(next) => {
                setQuiet(next ? { start: next.start, end: next.end, days: next.days } : null);
              }}
            />
          )}
        </Field>
        <Field
          label="Meter staleness"
          layout="row"
          help="A meter reading older than this greys its gauge; budget checks treat it as unknown."
          changed={stalenessN !== base.meterStalenessMinutes}
          error={stalenessN == null ? 'Enter a whole number of minutes' : null}
        >
          {({ id, describedBy, invalid: bad }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={bad}
              inputMode="numeric"
              className={styles.narrow}
              suffix="minutes"
              value={staleness}
              disabled={!isAdmin}
              onChange={(e) => {
                setStaleness(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Source silence"
          layout="row"
          help="A source with no event for this long shows on the Board as silent."
          changed={silenceN !== base.sourceSilenceMinutes}
          error={silenceN == null ? 'Enter a whole number of minutes' : null}
        >
          {({ id, describedBy, invalid: bad }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={bad}
              inputMode="numeric"
              className={styles.narrow}
              suffix="minutes"
              value={silence}
              disabled={!isAdmin}
              onChange={(e) => {
                setSilence(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="System notifier"
          layout="row"
          help="Breakers, unhealthy instances and stale meters are posted here."
          changed={notifier !== (base.systemNotifierId ?? '')}
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={notifier}
              disabled={!isAdmin}
              placeholder="None"
              options={(notifiers.data ?? []).map((n) => ({ value: n.id, label: n.name }))}
              onChange={(e) => {
                setNotifier(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Require a reason for every change"
          layout="row"
          help={
            requireReasons
              ? 'Every change asks for a one-line reason, recorded in the audit log. The API refuses a change without one.'
              : 'Changes save without a prompt and are audited as “(no reason given)”; destructive actions still ask to confirm, with an optional note. The audit log still records who changed what, and when.'
          }
          changed={requireReasons !== base.requireReasons}
        >
          {({ id, describedBy }) => (
            <Toggle
              id={id}
              describedBy={describedBy}
              checked={requireReasons}
              requires="admin"
              onChange={setRequireReasons}
            />
          )}
        </Field>
      </div>
      <div className={styles.footer}>
        {dirty && <span className="t-caption">unsaved changes</span>}
        <Button
          variant="primary"
          requires="admin"
          disabled={!dirty || invalid}
          disabledReason={invalid ? 'Fix the highlighted fields first' : 'Nothing changed'}
          loading={save.pending}
          onClick={() => void save.run({ settings: changes })}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}
