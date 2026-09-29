import type { JSONSchema, SecretRefDTO } from '@ai-switchboard/core/contract';
import { xDocs, xHelp, xPlaceholder, xWidget } from '@ai-switchboard/sdk/schema';
import { type ReactNode, useMemo, useState } from 'react';

import {
  asSchema,
  effectiveDefault,
  enumLabel,
  fieldKind,
  fieldSchema,
  fieldTitle,
  formatDefault,
  getIn,
  groupProperties,
  isSecretField,
  listItemValue,
  orderedProperties,
  pointer,
  resolveConditionals,
  schemaDefaults,
  setIn,
  textInputType,
  validateAgainstSchema,
  warningFor,
  type FieldKind,
  type ValuePath,
} from '../lib/schema.js';
import { samplePaths, type DeliverySample, type Suggestion } from '../lib/suggest.js';
import { Button } from './Button.js';
import { Checkbox } from './Checkbox.js';
import { CronField } from './CronField.js';
import { ExpressionEditor } from './ExpressionEditor.js';
import { Field, type FieldIds } from './Field.js';
import { PathInput } from './PathInput.js';
import styles from './SchemaForm.module.css';
import { SecretRefInput } from './SecretRefInput.js';
import { Radio } from './Radio.js';
import { Select } from './Select.js';
import { StringListInput } from './StringListInput.js';
import { Textarea } from './Textarea.js';
import { TextField } from './TextField.js';
import { Toggle } from './Toggle.js';

export interface SchemaFormProps {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  secretProviders?: string[];
  /** Matched to secret fields by field name. */
  secretStatus?: SecretRefDTO[];
  /** Show every validation message (after a save attempt); otherwise only touched fields. */
  showAllErrors?: boolean;
  /** The last saved value: changed fields get the tangerine dot. */
  baseline?: Record<string, unknown>;
  disabled?: boolean;
  /** `row` puts labels beside controls (settings pages). */
  layout?: 'stack' | 'row';
  /** Its dotted paths feed `x-widget: 'path'` suggestions and expression completions. */
  sample?: DeliverySample | null;
}

interface Ctx {
  root: Record<string, unknown>;
  set: (path: ValuePath, v: unknown) => void;
  errors: Record<string, string[]>;
  visible: (path: ValuePath) => boolean;
  secretProviders: string[] | undefined;
  secretStatus: SecretRefDTO[] | undefined;
  baseline: Record<string, unknown> | undefined;
  disabled: boolean;
  layout: 'stack' | 'row';
  paths: Suggestion[];
}

/**
 * Renders a plugin's JSON Schema as a form, honouring the `x-group`, `x-order`, `x-secret`,
 * `x-widget`, `x-placeholder`, `x-help`, `x-warning`, `x-docs` and `x-effectiveDefault` extensions
 * and `if`/`then`/`else` / `dependentRequired`. Gate a save with `validateAgainstSchema`.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  secretProviders,
  secretStatus,
  showAllErrors = false,
  baseline,
  disabled = false,
  layout = 'stack',
  sample,
}: SchemaFormProps) {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = useMemo(() => validateAgainstSchema(schema, value), [schema, value]);
  const paths = useMemo(() => (sample ? samplePaths(sample) : []), [sample]);
  const ctx: Ctx = {
    root: value,
    set: (path, v) => {
      const key = pointer(path);
      setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      onChange(setIn(value, path, v) as Record<string, unknown>);
    },
    errors,
    visible: (path) => {
      if (showAllErrors) return true;
      const key = pointer(path);
      for (const t of touched) if (t === key || t.startsWith(`${key}/`)) return true;
      return false;
    },
    secretProviders,
    secretStatus,
    baseline,
    disabled,
    layout,
    paths,
  };
  return (
    <div className={styles.form}>
      <ObjectFields schema={schema} path={[]} ctx={ctx} />
    </div>
  );
}

function ObjectFields({ schema, path, ctx }: { schema: JSONSchema; path: ValuePath; ctx: Ctx }) {
  const { required, hidden } = resolveConditionals(schema, getIn(ctx.root, path));
  const groups = groupProperties(orderedProperties(schema).filter(([key]) => !hidden.has(key)));
  return (
    <>
      {groups.map(({ group, fields }) => {
        const body = fields.map(([key, child]) => (
          <PropertyField
            key={key}
            name={key}
            schema={child}
            path={[...path, key]}
            required={required.includes(key)}
            ctx={ctx}
          />
        ));
        if (group == null)
          return (
            <div key="__ungrouped" className={styles.fields}>
              {body}
            </div>
          );
        return (
          <fieldset key={group} className={styles.group}>
            <legend className={styles.legend}>{group}</legend>
            <div className={styles.fields}>{body}</div>
          </fieldset>
        );
      })}
    </>
  );
}

function helpFor(s: JSONSchema, title: string): ReactNode {
  const description = typeof s.description === 'string' ? s.description : null;
  const long = xHelp(s);
  const docs = xDocs(s);
  if (!description && !long && !docs) return undefined;
  return (
    <>
      {description}
      {docs && (
        <>
          {' '}
          <a href={docs.url} target="_blank" rel="noreferrer">
            {docs.label}
          </a>
        </>
      )}
      {long && (
        <details className={styles.more}>
          <summary>More about {title.toLowerCase()}</summary>
          <p>{long}</p>
        </details>
      )}
    </>
  );
}

interface FieldProps {
  name: string;
  schema: JSONSchema;
  path: ValuePath;
  title: string;
  required: boolean;
  help: ReactNode;
  error: string | null;
  ctx: Ctx;
}

function PropertyField({
  name,
  schema: declared,
  path,
  required,
  ctx,
}: {
  name: string;
  schema: JSONSchema;
  path: ValuePath;
  required: boolean;
  ctx: Ctx;
}) {
  const schema = fieldSchema(declared);
  const title = fieldTitle(name, schema);
  const kind = fieldKind(schema);
  const key = pointer(path);
  const messages = ctx.visible(path) ? (ctx.errors[key] ?? []) : [];
  const props: FieldProps = {
    name,
    schema,
    path,
    title,
    required,
    help: helpFor(schema, title),
    error: messages.length ? messages.join(' · ') : null,
    ctx,
  };

  if (kind === 'object' && !isSecretField(schema)) return <NestedObjectField {...props} />;
  if (kind === 'array') {
    const items = fieldSchema(asSchema(schema.items) ?? {});
    if (fieldKind(items) === 'object') return <ObjectListField {...props} items={items} />;
    if (fieldKind(items) === 'enum') return <EnumListField {...props} items={items} />;
  }
  return <ControlField {...props} kind={kind} />;
}

function FieldGroup({
  title,
  required,
  help,
  children,
}: {
  title: string;
  required: boolean;
  help: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className={styles.nested}>
      <legend className={styles.legend}>
        {title}
        {required && <span className={styles.required}> *</span>}
      </legend>
      {help && <div className={styles.help}>{help}</div>}
      {children}
    </fieldset>
  );
}

function FieldError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <span className={styles.error} role="alert">
      {error}
    </span>
  );
}

function NestedObjectField({ schema, path, title, required, help, ctx }: FieldProps) {
  return (
    <FieldGroup title={title} required={required} help={help}>
      <ObjectFields schema={schema} path={path} ctx={ctx} />
    </FieldGroup>
  );
}

function ObjectListField({
  path,
  title,
  required,
  help,
  error,
  ctx,
  items,
}: FieldProps & { items: JSONSchema }) {
  const value = getIn(ctx.root, path);
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  const itemTitle = typeof items.title === 'string' ? items.title : title.replace(/s$/, '');
  return (
    <FieldGroup title={title} required={required} help={help}>
      <FieldError error={error} />
      {list.map((_, i) => (
        <fieldset key={i} className={styles.item}>
          <legend className={styles.itemLegend}>
            {itemTitle} {i + 1}
          </legend>
          <ObjectFields schema={items} path={[...path, i]} ctx={ctx} />
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              disabled={ctx.disabled}
              onClick={() => {
                ctx.set(
                  path,
                  list.filter((__, j) => j !== i),
                );
              }}
            >
              Remove {itemTitle.toLowerCase()} {i + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          disabled={ctx.disabled}
          onClick={() => {
            ctx.set(path, [...list, schemaDefaults(items) ?? {}]);
          }}
        >
          Add {itemTitle.toLowerCase()}
        </Button>
      </div>
    </FieldGroup>
  );
}

function EnumListField({
  path,
  title,
  required,
  help,
  error,
  ctx,
  items,
}: FieldProps & { items: JSONSchema }) {
  const value = getIn(ctx.root, path);
  const options = (Array.isArray(items.enum) ? (items.enum as unknown[]) : []).map(String);
  const selected = Array.isArray(value) ? (value as unknown[]).map(String) : [];
  return (
    <FieldGroup title={title} required={required} help={help}>
      <div className={styles.choices}>
        {options.map((o) => (
          <Checkbox
            key={o}
            variant="pill"
            label={o}
            checked={selected.includes(o)}
            disabled={ctx.disabled}
            onChange={(e) => {
              const next = e.target.checked ? [...selected, o] : selected.filter((x) => x !== o);
              ctx.set(path, next.length ? next : undefined);
            }}
          />
        ))}
      </div>
      <FieldError error={error} />
    </FieldGroup>
  );
}

function ControlField({
  name,
  schema,
  path,
  title,
  required,
  help,
  error,
  ctx,
  kind,
}: FieldProps & { kind: FieldKind }) {
  const value = getIn(ctx.root, path);
  const changed =
    ctx.baseline !== undefined &&
    JSON.stringify(getIn(ctx.baseline, path)) !== JSON.stringify(value);
  const hasDefault = 'default' in schema && !isSecretField(schema) && kind !== 'object';
  const aside = hasDefault ? (
    <span className={styles.default}>
      default <span className="mono">{formatDefault(schema.default)}</span>
    </span>
  ) : undefined;
  const set = (v: unknown) => {
    ctx.set(path, v);
  };
  return (
    <Field
      label={title}
      help={help}
      error={error}
      warning={warningFor(schema, value)}
      required={required}
      changed={changed}
      disabled={ctx.disabled}
      layout={ctx.layout}
      aside={aside}
    >
      {(ids) => (
        <Control
          ids={ids}
          name={name}
          schema={schema}
          path={path}
          kind={kind}
          title={title}
          required={required}
          value={value}
          changed={changed}
          placeholder={
            xPlaceholder(schema) ?? (hasDefault ? formatDefault(schema.default) : undefined)
          }
          ctx={ctx}
          set={set}
        />
      )}
    </Field>
  );
}

interface ControlProps {
  ids: FieldIds;
  name: string;
  schema: JSONSchema;
  path: ValuePath;
  kind: FieldKind;
  title: string;
  required: boolean;
  value: unknown;
  changed: boolean;
  placeholder: string | undefined;
  ctx: Ctx;
  set: (v: unknown) => void;
}

function Control(props: ControlProps) {
  const { ids, name, schema, kind, title, value, changed, placeholder, ctx, set } = props;
  const { id, describedBy, invalid } = ids;
  const widget = xWidget(schema);
  if (isSecretField(schema)) {
    return (
      <SecretRefInput
        id={id}
        describedBy={describedBy}
        invalid={invalid}
        label={title}
        value={value}
        providers={ctx.secretProviders}
        status={ctx.secretStatus?.find((s) => s.field === name)}
        disabled={ctx.disabled}
        onChange={set}
      />
    );
  }
  if (kind === 'enum' || (widget === 'select' && Array.isArray(schema.examples))) {
    return <EnumControl {...props} radio={widget === 'radio'} />;
  }
  if (kind === 'boolean') {
    return (
      <Toggle
        id={id}
        describedBy={describedBy}
        // An unset value shows the default the plugin will apply.
        checked={value === undefined ? schema.default === true : value === true}
        disabled={ctx.disabled}
        onChange={set}
      />
    );
  }
  if (kind === 'number' || kind === 'integer') {
    return (
      <TextField
        id={id}
        aria-describedby={describedBy}
        invalid={invalid}
        changed={changed}
        type="number"
        mono
        step={kind === 'integer' ? 1 : 'any'}
        min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
        max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
        placeholder={placeholder}
        disabled={ctx.disabled}
        className={styles.number}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e) => {
          const raw = e.target.value;
          set(raw === '' ? undefined : Number(raw));
        }}
      />
    );
  }
  if (kind === 'array') {
    const items = fieldSchema(asSchema(schema.items) ?? {});
    const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <StringListInput
        id={id}
        describedBy={describedBy}
        label={title}
        value={list}
        disabled={ctx.disabled}
        onChange={(next) => {
          set(next.map((text) => listItemValue(items, text)));
        }}
      />
    );
  }
  const text = typeof value === 'string' ? value : '';
  const setText = (v: string) => {
    set(v === '' ? undefined : v);
  };
  if (widget === 'cron') {
    return (
      <CronField
        id={id}
        describedBy={describedBy}
        hideTimezone
        disabled={ctx.disabled}
        value={{ cron: text, timezone: 'UTC' }}
        onChange={(v) => {
          setText(v.cron);
        }}
      />
    );
  }
  if (widget === 'expression') {
    return (
      <ExpressionEditor
        id={id}
        describedBy={describedBy}
        label={title}
        value={text}
        disabled={ctx.disabled}
        onChange={setText}
        textareaRows={4}
        completions={{ variables: [], extra: ctx.paths, switchboardFunctions: false }}
      />
    );
  }
  if (widget === 'path') {
    return (
      <PathInput
        id={id}
        describedBy={describedBy}
        label={title}
        value={text}
        paths={ctx.paths}
        invalid={invalid}
        changed={changed}
        placeholder={placeholder}
        disabled={ctx.disabled}
        onChange={setText}
      />
    );
  }
  if (widget === 'textarea' || widget === 'code') {
    return (
      <Textarea
        id={id}
        aria-describedby={describedBy}
        invalid={invalid}
        changed={changed}
        mono={widget === 'code'}
        rows={widget === 'code' ? 6 : 3}
        placeholder={xPlaceholder(schema) ?? undefined}
        disabled={ctx.disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
    );
  }
  return (
    <TextField
      id={id}
      aria-describedby={describedBy}
      invalid={invalid}
      changed={changed}
      type={textInputType(schema)}
      autoComplete={widget === 'password' ? 'new-password' : 'off'}
      placeholder={placeholder}
      disabled={ctx.disabled}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
      }}
    />
  );
}

function EnumControl({
  ids,
  schema,
  path,
  title,
  required,
  value,
  ctx,
  set,
  radio,
}: ControlProps & { radio: boolean }) {
  const { id, describedBy, invalid } = ids;
  const raw = (Array.isArray(schema.enum) ? schema.enum : schema.examples) as unknown[];
  const indexOf = (v: unknown) => raw.findIndex((o) => JSON.stringify(o) === JSON.stringify(v));
  const index = indexOf(value);
  const labelOf = (o: unknown): string => enumLabel(schema, o) ?? formatDefault(o);
  if (radio) {
    // Unset shows what the plugin will do: `x-effectiveDefault`, else the default.
    const unset = effectiveDefault(schema, getIn(ctx.root, path.slice(0, -1)));
    const shown =
      index === -1 && value === undefined && unset !== undefined ? indexOf(unset) : index;
    return (
      <div
        id={id}
        role="radiogroup"
        aria-label={title}
        aria-describedby={describedBy}
        className={styles.radioGroup}
      >
        {raw.map((o, i) => (
          <Radio
            key={JSON.stringify(o)}
            name={id}
            label={labelOf(o)}
            checked={i === shown}
            disabled={ctx.disabled}
            onChange={() => {
              set(raw[i]);
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      invalid={invalid}
      disabled={ctx.disabled}
      placeholder={required && index !== -1 ? undefined : 'Choose…'}
      options={raw.map((o, i) => ({ value: String(i), label: labelOf(o) }))}
      value={index === -1 ? '' : String(index)}
      onChange={(e) => {
        set(e.target.value === '' ? undefined : raw[Number(e.target.value)]);
      }}
    />
  );
}
