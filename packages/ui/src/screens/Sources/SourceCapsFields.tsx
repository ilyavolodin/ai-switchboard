import type { EventTypeSpec, SourceCapsDTO } from '@ai-switchboard/core/contract';
import { useId } from 'react';

import { Checkbox } from '../../components/Checkbox.js';
import { sameValue } from '../../lib/instances.js';
import { CapField } from '../shared/CapField.js';
import styles from '../shared/forms.module.css';

export interface SourceCapsFieldsProps {
  value: SourceCapsDTO;
  onChange: (next: SourceCapsDTO) => void;
  eventTypes: EventTypeSpec[];
  mode: 'push' | 'pull' | 'both' | undefined;
  baseline?: SourceCapsDTO;
  disabled?: boolean;
}

/**
 * Whether deliveries are verified is the plugin's own setting (the webhook's Verification), not a
 * cap.
 */
export function SourceCapsFields({
  value,
  onChange,
  eventTypes,
  mode,
  baseline,
  disabled,
}: SourceCapsFieldsProps) {
  const typesLabel = useId();
  const changed = (k: keyof SourceCapsDTO) =>
    baseline !== undefined && !sameValue(value[k], baseline[k]);
  const set = <K extends keyof SourceCapsDTO>(k: K, v: SourceCapsDTO[K]) => {
    onChange({ ...value, [k]: v });
  };
  const all = eventTypes.map((t) => t.type);
  const enabled = value.eventTypesEnabled ?? all;
  const toggleType = (type: string, on: boolean) => {
    const next = on ? [...new Set([...enabled, type])] : enabled.filter((t) => t !== type);
    // Every type ticked is the default: send nothing rather than a list that goes stale.
    set(
      'eventTypesEnabled',
      all.every((t) => next.includes(t)) ? undefined : all.filter((t) => next.includes(t)),
    );
  };

  return (
    <fieldset className={styles.caps} disabled={disabled}>
      <legend className={styles.legend}>Core caps</legend>
      <p className={styles.note}>
        Enforced by Switchboard before any process sees an event. Events over a cap are kept and
        marked source-throttled.
      </p>
      <CapField
        label="Events per hour"
        suffix="events"
        value={value.eventCapPerHour}
        changed={changed('eventCapPerHour')}
        onChange={(v) => {
          set('eventCapPerHour', v);
        }}
      />
      <CapField
        label="Events per day"
        suffix="events"
        value={value.eventCapPerDay}
        changed={changed('eventCapPerDay')}
        onChange={(v) => {
          set('eventCapPerDay', v);
        }}
      />
      {mode !== 'push' && (
        <CapField
          label="Poll interval"
          suffix="seconds"
          min={10}
          placeholder="plugin default"
          help="How often a pull source asks the upstream system for new events."
          value={value.pollIntervalSeconds}
          changed={changed('pollIntervalSeconds')}
          onChange={(v) => {
            set('pollIntervalSeconds', v);
          }}
        />
      )}
      {eventTypes.length > 0 && (
        <div className={styles.stack} style={{ gap: 6 }}>
          <span className={styles.typeName} id={typesLabel}>
            Event types{changed('eventTypesEnabled') ? ' · changed' : ''}
          </span>
          <div className={styles.types} role="group" aria-labelledby={typesLabel}>
            {eventTypes.map((t) => (
              <Checkbox
                key={t.type}
                variant="pill"
                label={<span className="mono">{t.type}</span>}
                aria-label={`Receive ${t.type}`}
                title={t.description}
                checked={enabled.includes(t.type)}
                onChange={(e) => {
                  toggleType(t.type, e.target.checked);
                }}
              />
            ))}
          </div>
          <p className={styles.note}>Unticked types are muted: they are recorded, never matched.</p>
        </div>
      )}
    </fieldset>
  );
}
