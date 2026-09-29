import type { ProcessDocument } from '@ai-switchboard/core/contract';

import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { Toggle } from '../../components/Toggle.js';
import { CoalesceDemo } from './CoalesceDemo.js';
import { batchingOn, setOptionalKey, withBatching } from './editorModel.js';
import { NumberRow } from './NumberRow.js';
import styles from './ProcessEditor.module.css';
import type { SectionProps } from './sectionProps.js';
import { useRestorableSwitch } from './useRestorableSwitch.js';

/** Off is max size 1 (see `batchingOn`). */
export function BatchingFields({ doc, baseline, set, errors, disabled }: SectionProps) {
  const b = doc.batching;
  const saved = baseline.batching;
  const on = batchingOn(b);
  const restore = useRestorableSwitch(b, saved, batchingOn);
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
          changed={on !== batchingOn(saved)}
        >
          {({ id, describedBy }) => (
            <Toggle
              id={id}
              describedBy={describedBy}
              ariaLabel="Batch events"
              checked={on}
              disabled={disabled}
              onChange={(next) => {
                const back = restore(next);
                set((d) => withBatching(d, next, back));
              }}
            />
          )}
        </Field>
        {on && (
          <>
            <NumberRow
              label="Debounce"
              help="wait this long after the last event before closing the batch"
              changed={b.debounceSeconds !== saved.debounceSeconds}
              error={errors['/batching/debounceSeconds']}
              integer
              max={86_400}
              suffix="seconds"
              value={b.debounceSeconds}
              disabled={disabled}
              onChange={(debounceSeconds) => {
                put({ debounceSeconds });
              }}
            />
            <NumberRow
              label="Max size"
              help="close the batch at this many events (at least 2; switch batching off for one run per event)"
              changed={b.maxSize !== saved.maxSize}
              error={errors['/batching/maxSize']}
              integer
              min={2}
              max={10_000}
              suffix="events"
              value={b.maxSize}
              disabled={disabled}
              onChange={(maxSize) => {
                put({ maxSize });
              }}
            />
            <NumberRow
              label="Max age"
              help="close at this age even while events keep arriving"
              changed={b.maxAgeSeconds !== saved.maxAgeSeconds}
              error={errors['/batching/maxAgeSeconds']}
              integer
              max={604_800}
              suffix="seconds"
              value={b.maxAgeSeconds}
              disabled={disabled}
              onChange={(maxAgeSeconds) => {
                put({ maxAgeSeconds });
              }}
            />
            <Field
              label="Group by"
              help="optional · one batch per key, e.g. artifact.id or attributes.repository"
              layout="row"
              changed={(b.groupBy ?? '') !== (saved.groupBy ?? '')}
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
                    set((d) => ({
                      ...d,
                      batching: setOptionalKey(d.batching, 'groupBy', groupBy || undefined),
                    }));
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
