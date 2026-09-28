import type {
  ExecutorDetail,
  ExecutorSummary,
  RecentBatchDTO,
} from '@ai-switchboard/core/contract';

import { errorMessage } from '../../api/client.js';
import { usePreviewInput } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { useDebounced } from '../../hooks/useDebounced.js';
import { batchOptions } from './batches.js';
import type { SectionProps } from './EditorSections.js';
import { NumberField } from './NumberField.js';
import styles from './ProcessEditor.module.css';

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * The executor: pick an instance, fill the target form rendered from the type's `targetSchema`,
 * and write the input mapping with a live preview of the produced input — validated by the API
 * against the type's `inputSchema` — for a chosen recent batch.
 */
export function ExecutorFields({
  doc,
  baseline,
  set,
  errors,
  disabled,
  executors,
  executor,
  executorLoading,
  batches,
  batchId,
  onBatchChange,
  showAllErrors,
}: SectionProps & {
  executors: ExecutorSummary[];
  executor: ExecutorDetail | undefined;
  executorLoading: boolean;
  batches: RecentBatchDTO[];
  batchId: string;
  onBatchChange: (id: string) => void;
  showAllErrors: boolean;
}) {
  const batch = batches.find((b) => b.id === batchId);
  const debounced = useDebounced(doc, 500);
  const preview = usePreviewInput(
    debounced.executor.instanceId
      ? {
          document: debounced,
          ...(batch ? { batchId: batch.id } : {}),
          mode: batch?.kind === 'sweep' || !batch ? 'sweep' : 'event',
        }
      : null,
  );

  return (
    <div className={styles.stack}>
      <Field
        label="Executor instance"
        layout="row"
        error={errors['/executor/instanceId']}
        changed={doc.executor.instanceId !== baseline.executor.instanceId}
        help={
          executor
            ? `type ${executor.typeId} · tracking ${executor.tracking}${executor.idempotentInvoke ? '' : ' · invoke is not idempotent'}`
            : 'changing it clears the target, usage caps and meter ceilings'
        }
      >
        {({ id, describedBy, invalid }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            size="sm"
            placeholder="Choose an executor…"
            value={doc.executor.instanceId}
            disabled={disabled}
            options={executors.map((x) => ({
              value: x.id,
              label: x.name,
              disabled: !x.pluginAvailable,
            }))}
            onChange={(e) => {
              const instanceId = e.target.value;
              set((d) => {
                const { usagePerDay: _drop, ...budgets } = d.budgets;
                return {
                  ...d,
                  executor: { instanceId, target: {} },
                  budgets: { ...budgets, meterCeilings: {} },
                };
              });
            }}
          />
        )}
      </Field>

      {executorLoading ? (
        <Skeleton lines={3} label="Loading the executor" />
      ) : executor ? (
        <div className={styles.subsection}>
          <span className="t-overline">target · from targetSchema</span>
          <SchemaForm
            schema={executor.targetSchema}
            value={asRecord(doc.executor.target)}
            baseline={
              baseline.executor.instanceId === doc.executor.instanceId
                ? asRecord(baseline.executor.target)
                : undefined
            }
            showAllErrors={showAllErrors}
            disabled={disabled}
            layout="row"
            onChange={(target) => {
              set((d) => ({ ...d, executor: { ...d.executor, target } }));
            }}
          />
        </div>
      ) : null}

      <div className={styles.twoCol}>
        <Field
          label="Input mapping"
          help="JSONata over { events, process, run, mode } → the executor’s inputSchema"
          changed={doc.input !== baseline.input}
          error={errors['/input']}
        >
          {({ id, describedBy }) => (
            <ExpressionEditor
              id={id}
              describedBy={describedBy}
              label="Input mapping"
              textareaRows={7}
              value={doc.input}
              disabled={disabled}
              completions={{ variables: ['events', 'process', 'run', 'mode'] }}
              insertions={[
                { label: 'events' },
                { label: 'events.artifact' },
                { label: 'run.id' },
                { label: 'mode' },
                {
                  label: '$secretRef("NAME")',
                  title: 'a reference the executor resolves; never the value',
                },
              ]}
              onChange={(input) => {
                set((d) => ({ ...d, input }));
              }}
            />
          )}
        </Field>
        <section className={styles.preview} aria-label="Input preview">
          <div className={styles.previewHead}>
            <span className="t-overline">preview</span>
            <span className={styles.grow} />
            <Select
              size="sm"
              aria-label="Preview batch"
              value={batchId}
              options={batchOptions(batches)}
              onChange={(e) => {
                onBatchChange(e.target.value);
              }}
            />
          </div>
          {preview.isError ? (
            <Banner tone="warn" title="Preview unavailable">
              {errorMessage(preview.error)}
            </Banner>
          ) : preview.data ? (
            <>
              <CodeBlock value={preview.data.input} label="Produced input" maxHeight={220} />
              {preview.data.valid ? (
                <span className={styles.valid}>
                  <Icon name="check" size={13} />
                  valid against inputSchema
                </span>
              ) : (
                <div className={styles.stack}>
                  <StatusChip tone="error" label="does not match inputSchema" size="sm" />
                  <ul className={styles.errorList} aria-label="Input problems">
                    {preview.data.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <span className="t-caption">
                    A run with this input fails before any budget is spent.
                  </span>
                </div>
              )}
            </>
          ) : (
            <Skeleton lines={4} label="Evaluating the mapping" />
          )}
        </section>
      </div>

      <Field
        label="Tracking deadline"
        help="an open run becomes unknown after this long"
        layout="row"
        error={errors['/trackingDeadlineMinutes']}
        changed={doc.trackingDeadlineMinutes !== baseline.trackingDeadlineMinutes}
      >
        {({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            integer
            min={1}
            max={100_000}
            suffix="minutes"
            value={doc.trackingDeadlineMinutes}
            disabled={disabled}
            onChange={(v) => {
              if (v != null) set((d) => ({ ...d, trackingDeadlineMinutes: v }));
            }}
          />
        )}
      </Field>
    </div>
  );
}
