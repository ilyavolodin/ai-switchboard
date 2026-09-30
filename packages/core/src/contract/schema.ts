type JsonTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** The JSON Schema `type` names a TypeScript type may validate as. */
export type JsonTypeOf<T> = [unknown] extends [T]
  ? JsonTypeName
  : T extends string
    ? 'string'
    : T extends number
      ? 'number' | 'integer'
      : T extends boolean
        ? 'boolean'
        : T extends null
          ? 'null'
          : T extends readonly unknown[]
            ? 'array'
            : T extends object
              ? 'object'
              : never;

export interface PropertySchema<T> {
  readonly type?: JsonTypeOf<T> | readonly JsonTypeOf<T>[];
  readonly enum?: readonly T[];
  readonly [keyword: string]: unknown;
}

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** A request body's JSON Schema, one property per field of `T`. */
export interface BodySchema<T> {
  readonly type: 'object';
  readonly required: readonly RequiredKeys<T>[];
  readonly properties: { readonly [K in keyof T]-?: PropertySchema<Exclude<T[K], undefined>> };
  readonly additionalProperties?: boolean;
}

type RequiredOf<S> = S extends { readonly required: readonly (infer K)[] } ? K : never;
type Missing<T, S> = Exclude<RequiredKeys<T>, RequiredOf<S>>;
type Unknown<T, S> = S extends { readonly properties: infer P } ? Exclude<keyof P, keyof T> : never;

type Complete<T, S> = [Missing<T, S>] extends [never]
  ? [Unknown<T, S>] extends [never]
    ? unknown
    : { unknownProperties: Unknown<T, S> }
  : { missingRequired: Missing<T, S> };

/**
 * Checks at compile time that `schema` describes `T`: every field has a property of a matching
 * JSON type, every required field is required, and nothing else is declared.
 */
export function bodySchema<T>() {
  return <const S extends BodySchema<T>>(schema: S & Complete<T, S>): S => schema;
}

/** A query string's JSON Schema: every parameter optional, unknown parameters ignored. */
export interface QuerySchema<T> {
  readonly type: 'object';
  readonly properties: { readonly [K in keyof T]-?: PropertySchema<Exclude<T[K], undefined>> };
}

type CompleteQuery<T, S> = [Unknown<T, S>] extends [never]
  ? unknown
  : { unknownProperties: Unknown<T, S> };

/** Like `bodySchema`, for a query string: one property per parameter of `T`, nothing else. */
export function querySchema<T>() {
  return <const S extends QuerySchema<T>>(schema: S & CompleteQuery<T, S>): S => schema;
}

/** A comma-separated list of values from `values`, e.g. `ok,error`. */
export function csvPattern(values: readonly string[]): string {
  const one = `(${values.join('|')})`;
  return `^${one}(,${one})*$`;
}
