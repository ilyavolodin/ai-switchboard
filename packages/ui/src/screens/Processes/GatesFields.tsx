import type { ProcessDocument } from '@ai-switchboard/core/contract';

import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { QuietHoursBar } from '../../components/QuietHoursBar.js';
import { Radio } from '../../components/Radio.js';
import { approvalMode, type ApprovalMode, setOptionalKey } from './editorModel.js';
import { NumberRow } from './NumberRow.js';
import styles from './ProcessEditor.module.css';
import type { SectionProps } from './sectionProps.js';

const MODES: { mode: ApprovalMode; label: string }[] = [
  { mode: 'none', label: 'none' },
  { mode: 'always', label: 'always' },
  { mode: 'expression', label: 'by expression' },
];

const DEFAULT_EXPRESSION = '$count(events) > 5';

export function GatesFields({ doc, baseline, set, errors, disabled }: SectionProps) {
  const g = doc.gates;
  const saved = baseline.gates;
  const mode = approvalMode(g.approval);
  const savedExpr =
    approvalMode(saved.approval) === 'expression' ? saved.approval : DEFAULT_EXPRESSION;
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
              set((d) => ({ ...d, gates: setOptionalKey(d.gates, 'quietHours', quietHours) }));
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
              {MODES.map((m) => (
                <Radio
                  key={m.mode}
                  variant="pill"
                  name="approval-mode"
                  label={m.label}
                  checked={mode === m.mode}
                  disabled={disabled}
                  onChange={() => {
                    put({ approval: m.mode === 'expression' ? savedExpr : m.mode });
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
      <NumberRow
        label="Breaker threshold"
        help="consecutive failed runs that open the breaker"
        error={errors['/gates/breaker/threshold']}
        changed={g.breaker.threshold !== saved.breaker.threshold}
        integer
        min={1}
        max={1000}
        suffix="failures"
        value={g.breaker.threshold}
        disabled={disabled}
        onChange={(threshold) => {
          put({ breaker: { ...g.breaker, threshold } });
        }}
      />
      <NumberRow
        label="Breaker cooldown"
        help="event runs are refused this long after it opens; sweeps still run"
        error={errors['/gates/breaker/cooldownMinutes']}
        changed={g.breaker.cooldownMinutes !== saved.breaker.cooldownMinutes}
        integer
        max={100_000}
        suffix="minutes"
        value={g.breaker.cooldownMinutes}
        disabled={disabled}
        onChange={(cooldownMinutes) => {
          put({ breaker: { ...g.breaker, cooldownMinutes } });
        }}
      />
    </div>
  );
}
