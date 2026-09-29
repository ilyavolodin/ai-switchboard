import type { InstanceSummary, ProcessDocument } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { Button } from '../../components/Button.js';
import { Checkbox } from '../../components/Checkbox.js';
import { CronField } from '../../components/CronField.js';
import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { QuietHoursBar } from '../../components/QuietHoursBar.js';
import { Radio } from '../../components/Radio.js';
import { Select } from '../../components/Select.js';
import { Toggle } from '../../components/Toggle.js';
import { CoalesceDemo } from './CoalesceDemo.js';
import { batchingOn, newNotification, newSchedule, withBatching } from './editorModel.js';
import { NumberField } from './NumberField.js';
import styles from './ProcessEditor.module.css';

export interface SectionProps {
  doc: ProcessDocument;
  baseline: ProcessDocument;
  set: (update: (doc: ProcessDocument) => ProcessDocument) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}

/**
 * Off is max size 1 (see `batchingOn`). Switching off and on again in one visit restores the values
 * it had.
 */
export function BatchingFields({ doc, baseline, set, errors, disabled }: SectionProps) {
  const b = doc.batching;
  const on = batchingOn(b);
  const [previous, setPrevious] = useState<ProcessDocument['batching'] | undefined>(undefined);
  const put = (patch: Partial<ProcessDocument['batching']>) => {
    set((d) => ({ ...d, batching: { ...d.batching, ...patch } }));
  };
  return (
    <div className={styles.twoCol}>
      <div className={styles.stack}>
        <Field
          label="Batch events"
          help={
            on
              ? 'events that arrive close together share one run'
              : 'off: every event is its own run, started at once — nothing waits and nothing is grouped'
          }
          layout="row"
          changed={on !== batchingOn(baseline.batching)}
        >
          {({ id, describedBy }) => (
            <Toggle
              id={id}
              describedBy={describedBy}
              ariaLabel="Batch events"
              checked={on}
              disabled={disabled}
              onChange={(next) => {
                if (!next) setPrevious(b);
                set((d) =>
                  withBatching(
                    d,
                    next,
                    previous ?? (batchingOn(baseline.batching) ? baseline.batching : undefined),
                  ),
                );
              }}
            />
          )}
        </Field>
        {on && (
          <>
            <Field
              label="Debounce"
              help="wait this long after the last event before closing the batch"
              layout="row"
              changed={b.debounceSeconds !== baseline.batching.debounceSeconds}
              error={errors['/batching/debounceSeconds']}
            >
              {({ id, describedBy }) => (
                <NumberField
                  id={id}
                  describedBy={describedBy}
                  integer
                  max={86_400}
                  suffix="seconds"
                  value={b.debounceSeconds}
                  disabled={disabled}
                  onChange={(v) => {
                    if (v != null) put({ debounceSeconds: v });
                  }}
                />
              )}
            </Field>
            <Field
              label="Max size"
              help="close the batch at this many events (at least 2; switch batching off for one run per event)"
              layout="row"
              changed={b.maxSize !== baseline.batching.maxSize}
              error={errors['/batching/maxSize']}
            >
              {({ id, describedBy }) => (
                <NumberField
                  id={id}
                  describedBy={describedBy}
                  integer
                  min={2}
                  max={10_000}
                  suffix="events"
                  value={b.maxSize}
                  disabled={disabled}
                  onChange={(v) => {
                    if (v != null) put({ maxSize: v });
                  }}
                />
              )}
            </Field>
            <Field
              label="Max age"
              help="close at this age even while events keep arriving"
              layout="row"
              changed={b.maxAgeSeconds !== baseline.batching.maxAgeSeconds}
              error={errors['/batching/maxAgeSeconds']}
            >
              {({ id, describedBy }) => (
                <NumberField
                  id={id}
                  describedBy={describedBy}
                  integer
                  max={604_800}
                  suffix="seconds"
                  value={b.maxAgeSeconds}
                  disabled={disabled}
                  onChange={(v) => {
                    if (v != null) put({ maxAgeSeconds: v });
                  }}
                />
              )}
            </Field>
            <Field
              label="Group by"
              help="optional · one batch per key, e.g. artifact.id or attributes.repository"
              layout="row"
              changed={(b.groupBy ?? '') !== (baseline.batching.groupBy ?? '')}
            >
              {({ id, describedBy }) => (
                <ExpressionEditor
                  id={id}
                  describedBy={describedBy}
                  label="Group-by expression"
                  textareaRows={1}
                  completions={{
                    variables: ['event', 'attributes', 'artifact', 'type', 'process', 'now'],
                  }}
                  value={b.groupBy ?? ''}
                  disabled={disabled}
                  insertions={[{ label: 'artifact.id' }, { label: 'event.sourceId' }]}
                  onChange={(groupBy) => {
                    put({ groupBy: groupBy === '' ? undefined : groupBy });
                  }}
                />
              )}
            </Field>
          </>
        )}
      </div>
      <CoalesceDemo batching={b} />
    </div>
  );
}

export function SchedulesFields({
  doc,
  set,
  errors,
  disabled,
  timezone,
}: SectionProps & { timezone: string }) {
  const put = (i: number, patch: Partial<ProcessDocument['schedules'][number]>) => {
    set((d) => ({
      ...d,
      schedules: d.schedules.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));
  };
  return (
    <div className={styles.stack}>
      {doc.schedules.length === 0 && (
        <p className="t-caption">
          No sweeps. A sweep runs the process on a schedule even without events — the input mapping
          sees <span className="mono">mode = &quot;sweep&quot;</span>.
        </p>
      )}
      {doc.schedules.map((s, i) => (
        <div key={s.id} className={styles.item} role="group" aria-label={`Schedule ${i + 1}`}>
          <div className={styles.itemHead}>
            <span className="t-overline">sweep {i + 1}</span>
            <Toggle
              size="sm"
              ariaLabel={`Schedule ${i + 1} enabled`}
              checked={s.enabled}
              disabled={disabled}
              onChange={(enabled) => {
                put(i, { enabled });
              }}
            />
            <span className={styles.itemSummary} />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                set((d) => ({ ...d, schedules: d.schedules.filter((_, j) => j !== i) }));
              }}
            >
              Remove
            </Button>
          </div>
          <Field label="Cron" layout="row" error={errors[`/schedules/${i}/cron`]}>
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
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          disabled={disabled}
          onClick={() => {
            set((d) => ({ ...d, schedules: [...d.schedules, newSchedule(d.schedules, timezone)] }));
          }}
        >
          Add schedule
        </Button>
      </div>
    </div>
  );
}

type ApprovalMode = 'none' | 'always' | 'expression';

export function GatesFields({ doc, baseline, set, errors, disabled }: SectionProps) {
  const g = doc.gates;
  const mode: ApprovalMode =
    g.approval === 'none' ? 'none' : g.approval === 'always' ? 'always' : 'expression';
  const savedExpr =
    baseline.gates.approval !== 'none' && baseline.gates.approval !== 'always'
      ? baseline.gates.approval
      : '$count(events) > 5';
  const put = (patch: Partial<ProcessDocument['gates']>) => {
    set((d) => ({ ...d, gates: { ...d.gates, ...patch } }));
  };
  return (
    <div className={styles.stack}>
      <Field
        label="Quiet hours"
        help="batches wait; the next run after the window does the work"
        layout="row"
      >
        {() => (
          <QuietHoursBar
            value={g.quietHours}
            disabled={disabled}
            onChange={(quietHours) => {
              set((d) => {
                const { quietHours: _drop, ...rest } = d.gates;
                return { ...d, gates: quietHours ? { ...rest, quietHours } : rest };
              });
            }}
          />
        )}
      </Field>
      <Field
        label="Approval"
        help="when true, the batch waits in Approvals for an operator"
        layout="row"
      >
        {() => (
          <div className={styles.stack}>
            <div role="radiogroup" aria-label="Approval rule" className={styles.pills}>
              {(['none', 'always', 'expression'] as const).map((m) => (
                <Radio
                  key={m}
                  variant="pill"
                  name="approval-mode"
                  label={m === 'none' ? 'none' : m === 'always' ? 'always' : 'by expression'}
                  checked={mode === m}
                  disabled={disabled}
                  onChange={() => {
                    put({ approval: m === 'expression' ? savedExpr : m });
                  }}
                />
              ))}
            </div>
            {mode === 'expression' && (
              <ExpressionEditor
                label="Approval expression"
                value={g.approval}
                disabled={disabled}
                completions={{ variables: ['events', 'process', 'run', 'mode'] }}
                insertions={[
                  { label: '$count(events)' },
                  { label: 'mode' },
                  { label: 'events.attributes' },
                ]}
                onChange={(approval) => {
                  put({ approval });
                }}
              />
            )}
          </div>
        )}
      </Field>
      <Field
        label="Breaker threshold"
        help="consecutive failed runs that open the breaker"
        layout="row"
        error={errors['/gates/breaker/threshold']}
        changed={g.breaker.threshold !== baseline.gates.breaker.threshold}
      >
        {({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            integer
            min={1}
            max={1000}
            suffix="failures"
            value={g.breaker.threshold}
            disabled={disabled}
            onChange={(v) => {
              if (v != null) put({ breaker: { ...g.breaker, threshold: v } });
            }}
          />
        )}
      </Field>
      <Field
        label="Breaker cooldown"
        help="event runs are refused this long after it opens; sweeps still run"
        layout="row"
        error={errors['/gates/breaker/cooldownMinutes']}
        changed={g.breaker.cooldownMinutes !== baseline.gates.breaker.cooldownMinutes}
      >
        {({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            integer
            max={100_000}
            suffix="minutes"
            value={g.breaker.cooldownMinutes}
            disabled={disabled}
            onChange={(v) => {
              if (v != null) put({ breaker: { ...g.breaker, cooldownMinutes: v } });
            }}
          />
        )}
      </Field>
    </div>
  );
}

const OUTCOMES = ['ok', 'error', 'held', 'throttled'] as const;

export function NotificationsFields({
  doc,
  set,
  disabled,
  notifiers,
}: SectionProps & { notifiers: InstanceSummary[] }) {
  const put = (i: number, patch: Partial<ProcessDocument['notify'][number]>) => {
    set((d) => ({ ...d, notify: d.notify.map((n, j) => (j === i ? { ...n, ...patch } : n)) }));
  };
  return (
    <div className={styles.stack}>
      {doc.notify.length === 0 && (
        <p className="t-caption">
          No notifications. Add one to hear about errors, holds and throttles.
        </p>
      )}
      {doc.notify.map((n, i) => (
        <div key={i} className={styles.item} role="group" aria-label={`Notification ${i + 1}`}>
          <div className={styles.itemHead}>
            <span className="t-overline">notification {i + 1}</span>
            <span className={styles.itemSummary} />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                set((d) => ({ ...d, notify: d.notify.filter((_, j) => j !== i) }));
              }}
            >
              Remove
            </Button>
          </div>
          <Field label="Notifier" layout="row">
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                size="sm"
                placeholder="Choose a notifier…"
                value={n.notifierId}
                disabled={disabled}
                options={notifiers.map((x) => ({ value: x.id, label: x.name }))}
                onChange={(e) => {
                  put(i, { notifierId: e.target.value });
                }}
              />
            )}
          </Field>
          <Field label="On" layout="row">
            {() => (
              <div
                className={styles.pills}
                role="group"
                aria-label={`Notification ${i + 1} outcomes`}
              >
                {OUTCOMES.map((o) => (
                  <Checkbox
                    key={o}
                    variant="pill"
                    label={o}
                    checked={n.on.includes(o)}
                    disabled={disabled}
                    onChange={(e) => {
                      put(i, {
                        on: e.target.checked
                          ? OUTCOMES.filter((x) => x === o || n.on.includes(x))
                          : n.on.filter((x) => x !== o),
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </Field>
          <Field label="Template" help="JSONata over { process, run, events }" layout="row">
            {({ id, describedBy }) => (
              <ExpressionEditor
                id={id}
                describedBy={describedBy}
                label="Notification template"
                value={n.template}
                disabled={disabled}
                completions={{ variables: ['process', 'run', 'events'] }}
                insertions={[
                  { label: 'process.name' },
                  { label: 'run.status' },
                  { label: 'run.externalUrl' },
                ]}
                onChange={(template) => {
                  put(i, { template });
                }}
              />
            )}
          </Field>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          disabled={disabled}
          onClick={() => {
            set((d) => ({ ...d, notify: [...d.notify, newNotification(notifiers[0]?.id ?? '')] }));
          }}
        >
          Add notification
        </Button>
      </div>
    </div>
  );
}
