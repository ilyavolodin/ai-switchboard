import type { JSONSchema, MeterSpec, Settings, UsageDimension } from '@ai-switchboard/sdk';
import { parseWith, tryParse } from '@ai-switchboard/sdk/schema';

export interface HttpSettings {
  /** Relative target URLs are appended to it; default headers are pinned to its origin. */
  baseUrl?: string;
  /** Default request headers; `authorization` is a secret. */
  headers: Record<string, string>;
  callbackSecret?: string;
  usageDimensions: UsageDimension[];
  /** URL returning `{ used, limit, resetsAt }`; declares the `endpoint` meter when set. */
  meterEndpoint?: string;
  meterUnit: string;
}

export const DEFAULT_USAGE_DIMENSIONS: UsageDimension[] = [
  {
    id: 'duration_seconds',
    title: 'Duration',
    unit: 'seconds',
    aggregate: 'sum',
    budgetable: true,
  },
  {
    id: 'response_bytes',
    title: 'Response size',
    unit: 'bytes',
    aggregate: 'sum',
    budgetable: false,
  },
];

const HEADER_NAME = "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$";

export const headersSchema: JSONSchema = {
  type: 'object',
  propertyNames: { pattern: HEADER_NAME },
  additionalProperties: { type: 'string' },
};

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'HTTP destination',
  description: 'Calls any HTTP endpoint: a job runner, a serverless function, a webhook.',
  properties: {
    baseUrl: {
      type: 'string',
      format: 'uri',
      pattern: '^https?://',
      title: 'Base URL',
      description:
        'Relative target URLs are appended to this URL. When set, the default headers (and the ' +
        'authorization secret) are only sent to this origin, and the health check requests it.',
      'x-group': 'Endpoint',
      'x-placeholder': 'https://jobs.internal.example.com/api',
    },
    headers: {
      type: 'object',
      title: 'Default headers',
      description:
        'Headers sent with every request to the base URL origin. A process target may add or ' +
        'override headers.',
      'x-group': 'Endpoint',
      properties: {
        authorization: {
          type: 'string',
          title: 'Authorization header',
          description: 'Full header value, e.g. "Bearer <token>". Stored as a secret reference.',
          'x-secret': true,
        },
      },
      propertyNames: { pattern: HEADER_NAME },
      additionalProperties: { type: 'string' },
      default: {},
    },
    callbackSecret: {
      type: 'string',
      minLength: 16,
      title: 'Callback secret',
      description:
        'Shared secret the backend uses to sign callbacks (HMAC-SHA256 of the raw body in ' +
        '`x-switchboard-signature: sha256=<hex>`). Required for targets with callback tracking.',
      'x-secret': true,
      'x-group': 'Callbacks',
    },
    usageDimensions: {
      type: 'array',
      title: 'Usage dimensions',
      description:
        'What this instance reports per run. `duration_seconds` and `response_bytes` are ' +
        "measured by the destination; any other id must come from a target's `usageFrom` " +
        'expression or the callback body.',
      'x-group': 'Usage',
      default: DEFAULT_USAGE_DIMENSIONS,
      items: {
        type: 'object',
        required: ['id', 'title', 'unit', 'aggregate', 'budgetable'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]*$',
            title: 'Id',
            description: 'Dimension id, e.g. `cost_usd`.',
          },
          title: { type: 'string', minLength: 1, title: 'Title', description: 'Shown in the UI.' },
          unit: {
            type: 'string',
            minLength: 1,
            title: 'Unit',
            description: 'count, tokens, seconds, bytes, usd, or any unit name.',
          },
          aggregate: {
            enum: ['sum', 'max'],
            title: 'Aggregate',
            description: 'How runs combine in statistics and budgets.',
          },
          budgetable: {
            type: 'boolean',
            title: 'Budgetable',
            description: 'Whether a process may set a daily cap on this dimension.',
          },
        },
      },
    },
    meterEndpoint: {
      type: 'string',
      minLength: 1,
      title: 'Meter endpoint',
      description:
        'Optional URL (absolute, or relative to the base URL) that answers GET with ' +
        '`{ "used": number, "limit": number, "resetsAt": "<ISO-8601>" }`. Declares a window ' +
        'meter named `endpoint`.',
      'x-group': 'Meters',
    },
    meterUnit: {
      type: 'string',
      minLength: 1,
      default: 'requests',
      title: 'Meter unit',
      description: "Unit of the meter endpoint's `used` and `limit`.",
      'x-group': 'Meters',
    },
  },
};

export function readSettings(settings: Settings): HttpSettings {
  return validateSettings(
    parseWith<HttpSettings>(settingsSchema, settings, 'http destination settings'),
  );
}

export function validateSettings(parsed: HttpSettings): HttpSettings {
  const ids = new Set<string>();
  for (const d of parsed.usageDimensions) {
    if (ids.has(d.id)) throw new Error(`usage dimension "${d.id}" is declared twice`);
    ids.add(d.id);
  }
  return parsed;
}

/** Falls back to the defaults on invalid settings. */
export function usageFor(settings: Settings): UsageDimension[] {
  return (
    tryParse<HttpSettings>(settingsSchema, settings)?.usageDimensions ?? DEFAULT_USAGE_DIMENSIONS
  );
}

export const ENDPOINT_METER_ID = 'endpoint';

export function metersFor(settings: Settings): MeterSpec[] {
  const parsed = tryParse<HttpSettings>(settingsSchema, settings);
  if (parsed?.meterEndpoint === undefined) return [];
  return [
    {
      id: ENDPOINT_METER_ID,
      title: 'Endpoint capacity',
      kind: 'window',
      unit: parsed.meterUnit,
      primary: true,
    },
  ];
}
