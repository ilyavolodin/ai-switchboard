import type { JSONSchema, SecretRefDTO } from '@ai-switchboard/core/contract';
import { type ReactNode, useMemo, useState } from 'react';

import {
  asSchema,
  fieldKind,
  fieldTitle,
  getIn,
  groupProperties,
  isSecretField,
  orderedProperties,
  pointer,
  resolveConditionals,
  schemaDefaults,
  setIn,
  validateAgainstSchema,
  warningFor,
  type ValuePath,
} from '../lib/schema.js';
import { Button } from './Button.js';
import { Checkbox } from './Checkbox.js';
import { CronField } from './CronField.js';
import { ExpressionEditor } from './ExpressionEditor.js';
import { Field } from './Field.js';
import styles from './SchemaForm.module.css';
import { SecretRefInput } from './SecretRefInput.js';
import { Select } from './Select.js';
import { StringListInput } from './StringListInput.js';
import { Textarea } from './Textarea.js';
import { TextField } from './TextField.js';
import { Toggle } from './Toggle.js';

export interface SchemaFormProps {
  /** The plugin's JSON Schema (draft 2020-12) for an object. */
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Secret provider ids for secret-reference fields (default env, file). */
  secretProviders?: string[];
  /** Resolution status of stored secret references, matched by field name. */
  secretStatus?: SecretRefDTO[];
  /** Show every validation message (after a save attempt); otherwise only touched fields. */
  showAllErrors?: boolean;
  /** The last saved value: changed fields get the tangerine dot. */
  baseline?: Record<string, unknown>;
  disabled?: boolean;
  /** `row` puts labels beside controls (settings pages). */
  layout?: 'stack' | 'row';
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
}

/**
 * Renders a plugin's JSON Schema as a native-looking form: strings, numbers, integers, booleans,
 * enums, arrays of strings (or of enum values), arrays of objects and nested objects; `x-group`
 * becomes fieldsets, `x-order` orders fields, `x-secret` fields are secret-reference inputs
 * (`secret://<provider>/<name>`, values never shown), `x-widget` picks textarea / password /
 * select / code / cron / expression, `x-placeholder` and `x-help` add hints, and `x-warning`
 * (`{ when, message }`) shows a red warning under a field while its value matches `when`.
 * `if`/`then`/`else` (also inside `allOf`) and `dependentRequired` decide which fields are shown
 * and required for the current value (see `resolveConditionals`). Titles, descriptions,
 * defaults and required markers come from the schema; Ajv validates as you type.
 * Controlled: `value` in, `onChange` out. Use `validateAgainstSchema` to gate a save.
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
}: SchemaFormProps) {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = useMemo(() => validateAgainstSchema(schema, value), [schema, value]);
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
  };
  return (
    <div className={styles.form}>
      <ObjectFields schema={schema} path={[]} ctx={ctx} />
    </div>
  );
}

function ObjectFields({ schema, path, ctx }: { schema: JSONSchema; path: ValuePath; ctx: Ctx }) {
  // `if`/`then`/`else` decide which fields apply to the current value and which are required.
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
  const long = typeof s['x-help'] === 'string' ? s['x-help'] : null;
  if (!description && !long) return undefined;
  return (
    <>
      {description}
      {long && (
        <details className={styles.more}>
          <summary>More about {title.toLowerCase()}</summary>
          <p>{long}</p>
        </details>
      )}
    </>
  );
}

function formatDefault(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : 'none';
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function PropertyField({
  name,
  schema,
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
  const title = fieldTitle(name, schema);
  const kind = fieldKind(schema);
  const value = getIn(ctx.root, path);
  const key = pointer(path);
  const messages = ctx.visible(path) ? (ctx.errors[key] ?? []) : [];
  const error = messages.length ? messages.join(' · ') : null;
  const changed =
    ctx.baseline !== undefined &&
    JSON.stringify(getIn(ctx.baseline, path)) !== JSON.stringify(value);
  const widget = typeof schema['x-widget'] === 'string' ? schema['x-widget'] : null;
  const placeholder =
    typeof schema['x-placeholder'] === 'string' ? schema['x-placeholder'] : undefined;
  const hasDefault = 'default' in schema && !isSecretField(schema) && kind !== 'object';
  const aside = hasDefault ? (
    <span className={styles.default}>
      default <span className="mono">{formatDefault(schema.default)}</span>
    </span>
  ) : undefined;
  const help = helpFor(schema, title);

  // Nested object: a fieldset of its own properties.
  if (kind === 'object' && !isSecretField(schema)) {
    return (
      <fieldset className={styles.nested}>
        <legend className={styles.legend}>
          {title}
          {required && <span className={styles.required}> *</span>}
        </legend>
        {help && <div className={styles.help}>{help}</div>}
        <ObjectFields schema={schema} path={path} ctx={ctx} />
      </fieldset>
    );
  }

  // Array of objects: repeated fieldsets.
  if (kind === 'array') {
    const items = asSchema(schema.items) ?? {};
    const list = Array.isArray(value) ? (value as unknown[]) : [];
    if (fieldKind(items) === 'object') {
      const itemTitle = typeof items.title === 'string' ? items.title : title.replace(/s$/, '');
      return (
        <fieldset className={styles.nested}>
          <legend className={styles.legend}>
            {title}
            {required && <span className={styles.required}> *</span>}
          </legend>
          {help && <div className={styles.help}>{help}</div>}
          {error && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
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
        </fieldset>
      );
    }
    // Array of enum values: a checkbox group.
    if (fieldKind(items) === 'enum') {
      const options = (items.enum as unknown[]).map(String);
      const selected = list.map(String);
      return (
        <fieldset className={styles.nested}>
          <legend className={styles.legend}>
            {title}
            {required && <span className={styles.required}> *</span>}
          </legend>
          {help && <div className={styles.help}>{help}</div>}
          <div className={styles.choices}>
            {options.map((o) => (
              <Checkbox
                key={o}
                variant="pill"
                label={o}
                checked={selected.includes(o)}
                disabled={ctx.disabled}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, o]
                    : selected.filter((x) => x !== o);
                  ctx.set(path, next.length ? next : undefined);
                }}
              />
            ))}
          </div>
          {error && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
        </fieldset>
      );
    }
  }

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
      {({ id, describedBy, invalid }) => {
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
              onChange={(v) => {
                ctx.set(path, v);
              }}
            />
          );
        }
        if (kind === 'enum' || (widget === 'select' && Array.isArray(schema.examples))) {
          const raw = (
            Array.isArray(schema.enum) ? schema.enum : (schema.examples as unknown[])
          ) as unknown[];
          const index = raw.findIndex((o) => JSON.stringify(o) === JSON.stringify(value));
          return (
            <Select
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={ctx.disabled}
              placeholder={required && index !== -1 ? undefined : 'Choose…'}
              options={raw.map((o, i) => ({ value: String(i), label: formatDefault(o) }))}
              value={index === -1 ? '' : String(index)}
              onChange={(e) => {
                ctx.set(path, e.target.value === '' ? undefined : raw[Number(e.target.value)]);
              }}
            />
          );
        }
        if (kind === 'boolean') {
          return (
            <Toggle
              id={id}
              describedBy={describedBy}
              checked={value === true}
              disabled={ctx.disabled}
              onChange={(v) => {
                ctx.set(path, v);
              }}
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
              placeholder={placeholder ?? (hasDefault ? formatDefault(schema.default) : undefined)}
              disabled={ctx.disabled}
              className={styles.number}
              value={typeof value === 'number' ? String(value) : ''}
              onChange={(e) => {
                const raw = e.target.value;
                ctx.set(path, raw === '' ? undefined : Number(raw));
              }}
            />
          );
        }
        if (kind === 'array') {
          const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
          return (
            <StringListInput
              id={id}
              describedBy={describedBy}
              label={title}
              value={list}
              disabled={ctx.disabled}
              onChange={(next) => {
                ctx.set(path, next);
              }}
            />
          );
        }
        const text = typeof value === 'string' ? value : '';
        const setText = (v: string) => {
          ctx.set(path, v === '' ? undefined : v);
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
              placeholder={placeholder}
              disabled={ctx.disabled}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
          );
        }
        const format = typeof schema.format === 'string' ? schema.format : null;
        return (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            changed={changed}
            type={
              widget === 'password'
                ? 'password'
                : format === 'email'
                  ? 'email'
                  : format === 'uri'
                    ? 'url'
                    : 'text'
            }
            autoComplete={widget === 'password' ? 'new-password' : 'off'}
            placeholder={placeholder ?? (hasDefault ? formatDefault(schema.default) : undefined)}
            disabled={ctx.disabled}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        );
      }}
    </Field>
  );
}
