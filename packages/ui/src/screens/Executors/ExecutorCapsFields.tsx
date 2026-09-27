import type { ExecutorCapsDTO, MeterSpec, UsageDimension } from '@ai-switchboard/core/contract';

import { sameValue } from '../../lib/instances.js';
import { CapField } from '../Sources/CapField.js';
import styles from '../Sources/forms.module.css';

export interface ExecutorCapsFieldsProps {
  value: ExecutorCapsDTO;
  onChange: (next: ExecutorCapsDTO) => void;
  /** Declared usage dimensions; budgetable ones get a per-day cap with their unit. */
  usage: UsageDimension[];
  /** Meters the core estimates from run counts (a limit to type in). */
  estimated: MeterSpec[];
  /** Whether the type declares any meter (poll and staleness only matter then). */
  hasMeters: boolean;
  baseline?: ExecutorCapsDTO;
  disabled?: boolean;
}

/**
 * The core's own caps for an executor: runs per hour and day, a per-day cap per budgetable usage
 * dimension (with its unit), how often meters are read and when a reading counts as stale, and
 * the limits of estimated meters.
 */
export function ExecutorCapsFields({
  value,
  onChange,
  usage,
  estimated,
  hasMeters,
  baseline,
  disabled,
}: ExecutorCapsFieldsProps) {
  const changed = (a: unknown, b: unknown) => baseline !== undefined && !sameValue(a, b);
  const set = <K extends keyof ExecutorCapsDTO>(k: K, v: ExecutorCapsDTO[K]) => {
    onChange({ ...value, [k]: v });
  };
  const setIn = (k: 'usagePerDay' | 'estimatedLimits', id: string, v: number | undefined) => {
    const next = Object.fromEntries(
      Object.entries({ ...value[k], [id]: v }).filter(([, x]) => x !== undefined),
    ) as Record<string, number>;
    set(k, Object.keys(next).length ? next : undefined);
  };
  const budgetable = usage.filter((u) => u.budgetable);

  return (
    <fieldset className={styles.caps} disabled={disabled}>
      <legend className={styles.legend}>Core caps</legend>
      <p className={styles.note}>
        Checked by the budget stage before every invoke, for all processes bound to this executor
        together. A run over a cap is throttled, not failed.
      </p>
      <CapField
        label="Runs per hour"
        suffix="runs"
        value={value.runsPerHour}
        changed={changed(value.runsPerHour, baseline?.runsPerHour)}
        onChange={(v) => {
          set('runsPerHour', v);
        }}
      />
      <CapField
        label="Runs per day"
        suffix="runs"
        value={value.runsPerDay}
        changed={changed(value.runsPerDay, baseline?.runsPerDay)}
        onChange={(v) => {
          set('runsPerDay', v);
        }}
      />
      {budgetable.map((u) => (
        <CapField
          key={u.id}
          label={`${u.title} per day`}
          suffix={u.unit}
          value={value.usagePerDay?.[u.id]}
          changed={changed(value.usagePerDay?.[u.id], baseline?.usagePerDay?.[u.id])}
          onChange={(v) => {
            setIn('usagePerDay', u.id, v);
          }}
        />
      ))}
      {hasMeters && (
        <>
          <CapField
            label="Meter poll interval"
            suffix="seconds"
            min={10}
            placeholder="60"
            help="How often Switchboard reads this executor's meters."
            value={value.meterPollSeconds}
            changed={changed(value.meterPollSeconds, baseline?.meterPollSeconds)}
            onChange={(v) => {
              set('meterPollSeconds', v);
            }}
          />
          <CapField
            label="Meter staleness"
            suffix="minutes"
            min={1}
            placeholder="global default"
            help="A reading older than this is stale: its gauge greys and only the run counters gate."
            value={value.meterStalenessMinutes}
            changed={changed(value.meterStalenessMinutes, baseline?.meterStalenessMinutes)}
            onChange={(v) => {
              set('meterStalenessMinutes', v);
            }}
          />
        </>
      )}
      {estimated.map((m) => (
        <CapField
          key={m.id}
          label={`${m.title} limit (estimated)`}
          suffix={`${m.unit}${m.estimate ? ` per ${m.estimate.period}` : ''}`}
          min={1}
          placeholder={m.estimate?.defaultLimit != null ? String(m.estimate.defaultLimit) : 'limit'}
          help="The backend does not report this meter; Switchboard counts runs against this limit."
          value={value.estimatedLimits?.[m.id]}
          changed={changed(value.estimatedLimits?.[m.id], baseline?.estimatedLimits?.[m.id])}
          onChange={(v) => {
            setIn('estimatedLimits', m.id, v);
          }}
        />
      ))}
    </fieldset>
  );
}
