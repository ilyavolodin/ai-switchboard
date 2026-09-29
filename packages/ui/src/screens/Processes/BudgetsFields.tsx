import type {
  DestinationDetail,
  MeterCeiling,
  ProcessDocument,
} from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { Field } from '../../components/Field.js';
import { MeterGauge } from '../../components/MeterGauge.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Toggle } from '../../components/Toggle.js';
import { formatCount } from '../../lib/format.js';
import { budgetsOn, setOptionalKey, withBudgets } from './editorModel.js';
import { NumberField } from './NumberField.js';
import { NumberRow } from './NumberRow.js';
import styles from './ProcessEditor.module.css';
import type { SectionProps } from './sectionProps.js';
import { useRestorableSwitch } from './useRestorableSwitch.js';

/** A ceiling of 100% throttles nothing; the inputs show it as empty. */
const NONE = 100;

function withCeiling(
  doc: ProcessDocument,
  meterId: string,
  kind: keyof MeterCeiling,
  value: number | undefined,
): ProcessDocument {
  const current = doc.budgets.meterCeilings[meterId] ?? { events: NONE, sweeps: NONE };
  const next = { ...current, [kind]: value ?? NONE };
  const { [meterId]: _drop, ...others } = doc.budgets.meterCeilings;
  return {
    ...doc,
    budgets: {
      ...doc.budgets,
      meterCeilings:
        next.events === NONE && next.sweeps === NONE ? others : { ...others, [meterId]: next },
    },
  };
}

function withUsageCap(
  doc: ProcessDocument,
  dimension: string,
  value: number | undefined,
): ProcessDocument {
  const { [dimension]: _drop, ...others } = doc.budgets.usagePerDay ?? {};
  const usagePerDay = value == null ? others : { ...others, [dimension]: value };
  const { usagePerDay: _old, ...budgets } = doc.budgets;
  return {
    ...doc,
    budgets: Object.keys(usagePerDay).length > 0 ? { ...budgets, usagePerDay } : budgets,
  };
}

/** On each meter's gauge the dark tick is the event ceiling, the light one the sweep ceiling. */
export function BudgetsFields({
  doc,
  baseline,
  set,
  errors,
  disabled,
  destination,
  destinationLoading,
  processId,
}: SectionProps & {
  destination: DestinationDetail | undefined;
  destinationLoading: boolean;
  processId: string;
}) {
  const b = doc.budgets;
  const dims = destination?.usage.filter((u) => u.budgetable) ?? [];
  // The switch is derived from the document (`budgetsOn`); `keepOpen` holds it on while every
  // field is being cleared in this visit, so emptying the last cap does not hide the fields.
  const [keepOpen, setKeepOpen] = useState(false);
  const restore = useRestorableSwitch(b, baseline.budgets, budgetsOn);
  const on = budgetsOn(b) || keepOpen;
  const destinationCaps = destination ? `${destination.name}'s` : "the destination's";
  return (
    <div className={styles.stack}>
      <Field
        label="Limit runs"
        help={
          on
            ? `this process's own caps; ${destinationCaps} caps apply as well`
            : `off: no runs-per-hour or per-day caps, usage caps or meter ceilings for this process — ${destinationCaps} own caps still apply`
        }
        layout="row"
        changed={budgetsOn(b) !== budgetsOn(baseline.budgets)}
      >
        {({ id, describedBy }) => (
          <Toggle
            id={id}
            describedBy={describedBy}
            ariaLabel="Limit runs"
            checked={on}
            disabled={disabled}
            onChange={(next) => {
              setKeepOpen(next);
              const back = restore(next);
              set((d) => withBudgets(d, next, back));
            }}
          />
        )}
      </Field>
      {on && (
        <BudgetLimits
          {...{
            doc,
            baseline,
            set,
            errors,
            disabled,
            destination,
            destinationLoading,
            processId,
            dims,
          }}
        />
      )}
    </div>
  );
}

function BudgetLimits({
  doc,
  baseline,
  set,
  errors,
  disabled,
  destination,
  destinationLoading,
  processId,
  dims,
}: SectionProps & {
  destination: DestinationDetail | undefined;
  destinationLoading: boolean;
  processId: string;
  dims: DestinationDetail['usage'];
}) {
  const b = doc.budgets;
  return (
    <div className={styles.twoCol}>
      <div className={styles.stack}>
        <NumberRow
          label="Runs per hour"
          help="empty = no cap"
          changed={b.runsPerHour !== baseline.budgets.runsPerHour}
          error={errors['/budgets/runsPerHour']}
          optional
          integer
          placeholder="no cap"
          suffix="runs"
          value={b.runsPerHour}
          disabled={disabled}
          onChange={(runsPerHour) => {
            set((d) => ({ ...d, budgets: setOptionalKey(d.budgets, 'runsPerHour', runsPerHour) }));
          }}
        />
        <NumberRow
          label="Runs per day"
          help="empty = no cap"
          changed={b.runsPerDay !== baseline.budgets.runsPerDay}
          error={errors['/budgets/runsPerDay']}
          optional
          integer
          placeholder="no cap"
          suffix="runs"
          value={b.runsPerDay}
          disabled={disabled}
          onChange={(runsPerDay) => {
            set((d) => ({ ...d, budgets: setOptionalKey(d.budgets, 'runsPerDay', runsPerDay) }));
          }}
        />
        <span className="t-overline">
          usage caps · budgetable dimensions the destination declares
        </span>
        {destinationLoading ? (
          <Skeleton lines={2} label="Loading usage dimensions" />
        ) : dims.length === 0 ? (
          <span className="t-caption">The bound destination declares no budgetable usage.</span>
        ) : (
          dims.map((u) => (
            <NumberRow
              key={u.id}
              label={<span className="mono">{u.id} / day</span>}
              help={u.title}
              changed={b.usagePerDay?.[u.id] !== baseline.budgets.usagePerDay?.[u.id]}
              error={errors[`/budgets/usagePerDay/${u.id}`]}
              optional
              placeholder="no cap"
              suffix={u.unit}
              value={b.usagePerDay?.[u.id]}
              disabled={disabled}
              onChange={(v) => {
                set((d) => withUsageCap(d, u.id, v));
              }}
            />
          ))
        )}
      </div>
      <div className={styles.stack}>
        <span className="t-overline">
          meter ceilings{destination ? ` · ${destination.name}` : ''}
        </span>
        {destinationLoading ? (
          <Skeleton lines={3} label="Loading meters" />
        ) : !destination || destination.meters.length === 0 ? (
          <span className="t-caption">The bound destination reports no meters.</span>
        ) : (
          <ul className={styles.meters} aria-label="Meter ceilings">
            {destination.meters.map((m) => {
              const c = b.meterCeilings[m.meterId];
              const gauge = {
                ...m,
                ceilings: c
                  ? [{ processId, processName: doc.name, events: c.events, sweeps: c.sweeps }]
                  : [],
              };
              const shown = (v: number | undefined) => (v == null || v === NONE ? undefined : v);
              return (
                <li key={m.meterId} className={styles.meterRow}>
                  <MeterGauge meter={gauge} size="md" label="none" showSweepCeilings />
                  <span className={styles.meterTitle}>
                    {m.title}
                    {m.estimated && <span className="t-caption"> · estimated</span>}
                    <span className="t-caption">
                      {' '}
                      · now {m.utilization != null ? `${formatCount(m.utilization)}%` : '—'}
                    </span>
                  </span>
                  <span className={styles.ceilingInputs}>
                    events
                    <NumberField
                      ariaLabel={`${m.title} event ceiling`}
                      optional
                      max={100}
                      suffix="%"
                      placeholder="none"
                      className={styles.pct}
                      value={shown(c?.events)}
                      disabled={disabled}
                      onChange={(v) => {
                        set((d) => withCeiling(d, m.meterId, 'events', v));
                      }}
                    />
                    sweeps
                    <NumberField
                      ariaLabel={`${m.title} sweep ceiling`}
                      optional
                      max={100}
                      suffix="%"
                      placeholder="none"
                      className={styles.pct}
                      value={shown(c?.sweeps)}
                      disabled={disabled}
                      onChange={(v) => {
                        set((d) => withCeiling(d, m.meterId, 'sweeps', v));
                      }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <span className="t-caption">
          Above a ceiling the batch is throttled, not lost; the next sweep does the work. Keep the
          sweep ceiling higher so sweeps still run when events are throttled.
        </span>
      </div>
    </div>
  );
}
