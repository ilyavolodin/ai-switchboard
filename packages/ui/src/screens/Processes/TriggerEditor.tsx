import type { SourceSummary, Trigger } from '@ai-switchboard/core/contract';

import { errorMessage } from '../../api/client.js';
import { usePreviewFilter, useSource } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { Checkbox } from '../../components/Checkbox.js';
import { CodeBlock } from '../../components/CodeBlock.js';
import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StringListInput } from '../../components/StringListInput.js';
import { TextField } from '../../components/TextField.js';
import { Toggle } from '../../components/Toggle.js';
import { useDebounced } from '../../hooks/useDebounced.js';
import { declaredAttributes, defaultDescribe } from './editorModel.js';
import styles from './ProcessEditor.module.css';

export interface TriggerEditorProps {
  trigger: Trigger;
  index: number;
  sources: SourceSummary[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: Trigger) => void;
  onRemove: () => void;
  /** Messages keyed by JSON pointer under this trigger (`/sourceId`, `/eventTypes`). */
  errors: Record<string, string>;
  disabled?: boolean;
}

/**
 * One trigger: pick a source instance, tick event types from its declared list, write the filter
 * with the declared attributes and examples at hand while it is evaluated live against the last
 * 20 real events, and keep the `describe` sentence (generated until the person writes their own).
 */
export function TriggerEditor({
  trigger,
  index,
  sources,
  expanded,
  onToggleExpanded,
  onChange,
  onRemove,
  errors,
  disabled,
}: TriggerEditorProps) {
  const source = useSource(trigger.sourceId || undefined);
  const summary = sources.find((s) => s.id === trigger.sourceId);
  const specs = source.data?.eventTypes ?? [];
  const sourceName = summary?.name ?? source.data?.name ?? '';
  const n = index + 1;

  const debouncedFilter = useDebounced(trigger.filter ?? '', 400);
  const preview = usePreviewFilter(
    expanded && trigger.sourceId && trigger.eventTypes.length > 0
      ? {
          sourceId: trigger.sourceId,
          eventTypes: trigger.eventTypes,
          ...(debouncedFilter.trim() ? { filter: debouncedFilter } : {}),
          limit: 20,
        }
      : null,
  );

  const suggestion = defaultDescribe(sourceName, specs, trigger.eventTypes, trigger.filter);
  /** Applies a change and keeps a generated describe sentence in step with it. */
  const change = (patch: Partial<Trigger>, name = sourceName) => {
    const next = { ...trigger, ...patch };
    const auto = trigger.describe === '' || trigger.describe === suggestion;
    if (auto) next.describe = defaultDescribe(name, specs, next.eventTypes, next.filter);
    onChange(next);
  };

  const counts = new Map(summary?.eventsByType24h.map((e) => [e.type, e.count]) ?? []);
  const attributes = declaredAttributes(specs, trigger.eventTypes);
  // Types that accept any attribute (a quick-mode webhook) declare none: offer the ones recent
  // events actually carried.
  const seenAttributes = [
    ...new Set((preview.data?.rows ?? []).flatMap((r) => Object.keys(r.attributes))),
  ]
    .filter((name) => !attributes.some((a) => a.name === name))
    .map((name) => ({ name, type: 'seen in recent events' }));
  const examples = specs
    .filter((s) => trigger.eventTypes.includes(s.type) && s.examples.length > 0)
    .map((s) => ({ type: s.type, examples: s.examples }));

  return (
    <div className={styles.item} aria-label={`Trigger ${n}`} role="group">
      <div className={styles.itemHead}>
        <span className="t-overline">trigger {n}</span>
        <Toggle
          size="sm"
          ariaLabel={`Trigger ${n} enabled`}
          checked={trigger.enabled}
          disabled={disabled}
          onChange={(enabled) => {
            onChange({ ...trigger, enabled });
          }}
        />
        <span className={styles.itemSummary}>
          {expanded
            ? sourceName && `${sourceName} · ${summary?.typeName ?? ''}`
            : trigger.describe || `${sourceName || 'no source'} · ${trigger.eventTypes.join(', ')}`}
        </span>
        <Button size="sm" variant="ghost" onClick={onToggleExpanded} aria-expanded={expanded}>
          {expanded ? 'Collapse' : 'Edit'}
        </Button>
        <Button size="sm" variant="outline" onClick={onRemove} disabled={disabled}>
          Remove
        </Button>
      </div>

      {expanded && (
        <>
          <Field label="Source" error={errors['/sourceId']} layout="row">
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                size="sm"
                placeholder="Choose a source…"
                value={trigger.sourceId}
                disabled={disabled}
                options={sources.map((s) => ({
                  value: s.id,
                  label: s.name,
                  disabled: !s.pluginAvailable,
                }))}
                onChange={(e) => {
                  const next = sources.find((s) => s.id === e.target.value);
                  change(
                    { sourceId: e.target.value, eventTypes: [], describe: '' },
                    next?.name ?? '',
                  );
                }}
              />
            )}
          </Field>

          {trigger.sourceId && (
            <Field
              label="Event types"
              help={
                specs.length > 0 ? 'from the plugin manifest · counts are the last 24 h' : undefined
              }
              error={errors['/eventTypes']}
              layout="row"
            >
              {({ id, describedBy }) =>
                source.isPending ? (
                  <Skeleton width={260} height={30} label="Loading event types" />
                ) : specs.length > 0 ? (
                  <div
                    id={id}
                    role="group"
                    aria-label="Event types"
                    aria-describedby={describedBy}
                    className={styles.pills}
                  >
                    {specs.map((spec) => (
                      <Checkbox
                        key={spec.type}
                        variant="pill"
                        label={<span className="mono">{spec.type}</span>}
                        title={`${spec.title} — ${spec.description}`}
                        hint={counts.get(spec.type) ?? 0}
                        aria-label={spec.type}
                        checked={trigger.eventTypes.includes(spec.type)}
                        disabled={disabled}
                        onChange={(e) => {
                          const on = e.target.checked;
                          change({
                            eventTypes: on
                              ? [...trigger.eventTypes, spec.type]
                              : trigger.eventTypes.filter((t) => t !== spec.type),
                          });
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={styles.stack}>
                    <span className="t-caption">
                      This source type declares no event types; type the ones it sends.
                    </span>
                    <StringListInput
                      id={id}
                      describedBy={describedBy}
                      label="Event type"
                      mono
                      value={trigger.eventTypes}
                      placeholder="pull_request.opened"
                      disabled={disabled}
                      onChange={(eventTypes) => {
                        change({ eventTypes });
                      }}
                    />
                  </div>
                )
              }
            </Field>
          )}

          {trigger.sourceId && trigger.eventTypes.length > 0 && (
            <>
              <Field
                label="Filter"
                help="JSONata over { event, process, now } · empty = every event"
                layout="row"
              >
                {({ id, describedBy }) => (
                  <div className={styles.stack}>
                    <ExpressionEditor
                      id={id}
                      describedBy={describedBy}
                      label="Filter expression"
                      value={trigger.filter ?? ''}
                      disabled={disabled}
                      completions={{
                        variables: ['event', 'attributes', 'artifact', 'type', 'process', 'now'],
                        attributes: [...attributes, ...seenAttributes],
                      }}
                      onChange={(filter) => {
                        change({ filter: filter === '' ? undefined : filter });
                      }}
                      insertions={[
                        ...attributes.map((a) => ({
                          label: `attributes.${a.name}`,
                          title: [a.type, a.description].filter(Boolean).join(' · '),
                        })),
                        {
                          label: '$resolve(artifact)',
                          title: 'live: the artifact as its system has it now',
                        },
                        { label: '$linked(artifact)', title: 'live: linked artifacts' },
                      ]}
                      rows={preview.data?.rows}
                      evaluating={preview.isFetching}
                      previewError={preview.isError ? errorMessage(preview.error) : null}
                      summarize={(row) =>
                        Object.entries(row.attributes)
                          .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                          .join(' · ')
                      }
                    />
                    {examples.length > 0 && (
                      <details className={styles.examples}>
                        <summary>Examples from the manifest</summary>
                        {examples.map((x) => (
                          <CodeBlock
                            key={x.type}
                            label={`${x.type} examples`}
                            value={x.examples}
                            maxHeight={160}
                          />
                        ))}
                      </details>
                    )}
                  </div>
                )}
              </Field>

              <Field
                label="Describe"
                help="shown on every other screen"
                layout="row"
                aside={
                  suggestion && trigger.describe !== suggestion ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        onChange({ ...trigger, describe: suggestion });
                      }}
                    >
                      Use suggestion
                    </Button>
                  ) : undefined
                }
              >
                {({ id, describedBy }) => (
                  <TextField
                    id={id}
                    aria-describedby={describedBy}
                    size="sm"
                    value={trigger.describe}
                    placeholder={suggestion}
                    disabled={disabled}
                    onChange={(e) => {
                      onChange({ ...trigger, describe: e.target.value });
                    }}
                  />
                )}
              </Field>
            </>
          )}
        </>
      )}
    </div>
  );
}
