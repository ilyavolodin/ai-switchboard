import type { ActionSpec, ProcessDocument, Step } from '@ai-switchboard/core/contract';

import { useDestination, useSource } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { TextField } from '../../components/TextField.js';
import { asSchema } from '../../lib/schema.js';
import type { SectionProps } from './EditorSections.js';
import { newStep } from './editorModel.js';
import styles from './ProcessEditor.module.css';

export interface StepProvider {
  id: string;
  name: string;
  kind: 'source' | 'destination';
}

type Phase = 'before' | 'after';

function StepEditor({
  step,
  index,
  phase,
  providers,
  onChange,
  onRemove,
  disabled,
}: {
  step: Step;
  index: number;
  phase: Phase;
  providers: StepProvider[];
  onChange: (next: Step) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const provider = providers.find((p) => p.id === step.provider);
  const source = useSource(provider?.kind === 'source' ? provider.id : undefined);
  const destination = useDestination(provider?.kind === 'destination' ? provider.id : undefined);
  const actions: ActionSpec[] =
    (provider?.kind === 'destination' ? destination.data?.actions : source.data?.actions) ?? [];
  const action = actions.find((a) => a.id === step.action);
  const argNames = Object.keys(asSchema(action?.argsSchema.properties) ?? {});
  const label = `${phase === 'before' ? 'Before' : 'After'} step ${index + 1}`;

  return (
    <div className={styles.item} role="group" aria-label={label}>
      <div className={styles.itemHead}>
        <span className="t-overline">{label}</span>
        <span className={styles.itemSummary}>{action?.description ?? action?.describe ?? ''}</span>
        <Button size="sm" variant="outline" onClick={onRemove} disabled={disabled}>
          Remove
        </Button>
      </div>
      <Field label="Provider" layout="row">
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            size="sm"
            placeholder="Choose a source or destination…"
            value={step.provider}
            disabled={disabled}
            options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` }))}
            onChange={(e) => {
              onChange({ ...step, provider: e.target.value, action: '' });
            }}
          />
        )}
      </Field>
      <Field
        label="Action"
        layout="row"
        help={provider && actions.length === 0 ? 'this provider declares no actions' : undefined}
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            size="sm"
            placeholder="Choose an action…"
            value={step.action}
            disabled={disabled === true || !provider}
            options={actions.map((a) => ({ value: a.id, label: a.title }))}
            onChange={(e) => {
              onChange({ ...step, action: e.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label="Arguments"
        layout="row"
        help={`JSONata over { events, run${phase === 'after' ? ', result' : ''} }`}
      >
        {({ id, describedBy }) => (
          <ExpressionEditor
            id={id}
            describedBy={describedBy}
            label={`${label} arguments`}
            value={step.args}
            disabled={disabled}
            completions={{
              variables: phase === 'after' ? ['events', 'run', 'result'] : ['events', 'run'],
            }}
            insertions={argNames.map((n) => ({ label: n, insert: `"${n}": ` }))}
            onChange={(args) => {
              onChange({ ...step, args });
            }}
          />
        )}
      </Field>
      <Field label="Condition" layout="row" help="optional · the step runs only when this is true">
        {({ id, describedBy }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            size="sm"
            mono
            value={step.when ?? ''}
            placeholder={phase === 'after' ? 'result.ok' : 'always'}
            disabled={disabled}
            onChange={(e) => {
              const when = e.target.value;
              onChange({ ...step, when: when === '' ? undefined : when });
            }}
          />
        )}
      </Field>
    </div>
  );
}

export function StepsFields({
  doc,
  set,
  disabled,
  providers,
}: SectionProps & { providers: StepProvider[] }) {
  const phases: Phase[] = ['before', 'after'];
  const putList = (phase: Phase, list: Step[]) => {
    set((d: ProcessDocument) => ({ ...d, [phase]: list }));
  };
  return (
    <div className={styles.stack}>
      {phases.map((phase) => {
        const list = doc[phase];
        return (
          <div key={phase} className={styles.stack}>
            <span className="t-overline">
              {phase === 'before' ? 'before the run is invoked' : 'after the run settles'}
            </span>
            {list.length === 0 && <span className="t-caption">No {phase} steps.</span>}
            {list.map((s, i) => (
              <StepEditor
                key={i}
                step={s}
                index={i}
                phase={phase}
                providers={providers}
                disabled={disabled}
                onChange={(next) => {
                  putList(
                    phase,
                    list.map((x, j) => (j === i ? next : x)),
                  );
                }}
                onRemove={() => {
                  putList(
                    phase,
                    list.filter((_, j) => j !== i),
                  );
                }}
              />
            ))}
            <div>
              <Button
                size="sm"
                variant="outline"
                icon="plus"
                disabled={disabled === true || providers.length === 0}
                disabledReason="Bind a source or a destination first"
                onClick={() => {
                  putList(phase, [...list, newStep(providers[0]?.id ?? '')]);
                }}
              >
                Add {phase} step
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
