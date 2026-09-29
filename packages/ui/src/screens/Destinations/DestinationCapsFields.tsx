import type { DestinationCapsDTO, MeterSpec, UsageDimension } from '@ai-switchboard/core/contract';

import { sameValue } from '../../lib/instances.js';
import { CapField } from '../shared/CapField.js';
import styles from '../shared/forms.module.css';
import {
  DEFAULT_INVOKE_TIMEOUT_SECONDS,
  DEFAULT_METER_POLL_SECONDS,
  MAX_INVOKE_TIMEOUT_SECONDS,
  MIN_METER_POLL_SECONDS,
} from './destinationModel.js';

export interface DestinationCapsFieldsProps {
  value: DestinationCapsDTO;
  onChange: (next: DestinationCapsDTO) => void;
  usage: UsageDimension[];
  estimated: MeterSpec[];
  hasMeters: boolean;
  baseline?: DestinationCapsDTO;
  disabled?: boolean;
}

export function DestinationCapsFields({
  value,
  onChange,
  usage,
  estimated,
  hasMeters,
  baseline,
  disabled,
}: DestinationCapsFieldsProps) {
  const changed = (a: unknown, b: unknown) => baseline !== undefined && !sameValue(a, b);
  const set = <K extends keyof DestinationCapsDTO>(k: K, v: DestinationCapsDTO[K]) => {
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
        Checked by the budget stage before every invoke, for all processes bound to this destination
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
      <CapField
        label="Invoke timeout"
        suffix="seconds"
        min={1}
        max={MAX_INVOKE_TIMEOUT_SECONDS}
        placeholder="type default"
        help={`How long to wait for the backend to answer an invoke (1–${MAX_INVOKE_TIMEOUT_SECONDS} s). Empty uses the destination type's value, else ${DEFAULT_INVOKE_TIMEOUT_SECONDS} s. No answer in time counts as a lost response: retried when the destination is idempotent, otherwise the run is uncertain.`}
        value={value.invokeTimeoutSeconds}
        changed={changed(value.invokeTimeoutSeconds, baseline?.invokeTimeoutSeconds)}
        onChange={(v) => {
          set('invokeTimeoutSeconds', v);
        }}
      />
      {hasMeters && (
        <>
          <CapField
            label="Meter poll interval"
            suffix="seconds"
            min={MIN_METER_POLL_SECONDS}
            placeholder={String(DEFAULT_METER_POLL_SECONDS)}
            help="How often Switchboard reads this destination's meters."
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
