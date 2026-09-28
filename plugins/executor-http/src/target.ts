import {
  InvokeError,
  type JSONSchema,
  type TrackingMode,
  SchemaMismatchError,
  parseWith,
  tryParse,
} from '@ai-switchboard/sdk';

import { headersSchema } from './settings.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Tracking modes a process may pick for an `http` target. */
export const HTTP_TRACKING = ['sync', 'callback', 'none'] as const;
export type HttpTracking = (typeof HTTP_TRACKING)[number];

/** What a process names to run: one HTTP request. */
export interface HttpTarget {
  method: HttpMethod;
  /** Absolute, or relative to the instance's base URL. */
  url: string;
  headers?: Record<string, string>;
  tracking: HttpTracking;
  /** The endpoint deduplicates on `x-switchboard-run-id`, so a lost response may be retried. */
  idempotent: boolean;
  /** JSONata over `{ response: { status, headers, body }, durationSeconds }` → usage report. */
  usageFrom?: string;
  timeoutSeconds?: number;
}

export const targetSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'HTTP request',
  description: 'The request a run sends. The input mapping produces the JSON body.',
  required: ['url'],
  additionalProperties: false,
  properties: {
    method: {
      enum: HTTP_METHODS,
      default: 'POST',
      title: 'Method',
      description: 'GET and DELETE send no body.',
    },
    url: {
      type: 'string',
      minLength: 1,
      title: 'URL',
      description: "Absolute URL, or a path appended to the instance's base URL.",
      'x-placeholder': '/jobs/triage',
    },
    headers: {
      ...headersSchema,
      title: 'Headers',
      description: "Added to (and overriding) the instance's default headers.",
    },
    tracking: {
      enum: HTTP_TRACKING,
      default: 'sync',
      title: 'Tracking',
      description:
        'sync: the response is the result. callback: the endpoint answers 2xx at once and later ' +
        'POSTs a signed callback. none: fire and forget, a 2xx closes the run as ok.',
    },
    idempotent: {
      type: 'boolean',
      default: false,
      title: 'Idempotent',
      description:
        'Tick only if the endpoint deduplicates on the x-switchboard-run-id header: the core ' +
        'may then retry a request whose response was lost.',
    },
    usageFrom: {
      type: 'string',
      minLength: 1,
      title: 'Usage expression',
      description:
        'Sync only. JSONata over { response: { status, headers, body }, durationSeconds } ' +
        'returning an object of dimension id → number, e.g. { "cost_usd": response.body.cost }.',
      'x-widget': 'expression',
    },
    timeoutSeconds: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 900,
      title: 'Timeout (seconds)',
      description:
        'Request timeout. Defaults to 30 seconds. Switchboard waits 10 seconds longer for the ' +
        'run as a whole, then treats the response as lost.',
    },
  },
};

export const inputSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Request body',
  description: 'Any JSON value; sent as the request body with content-type application/json.',
};

/** Validate a target and apply defaults. A bad target is definitive: retrying cannot fix it. */
export function readTarget(target: unknown): HttpTarget {
  try {
    return parseWith<HttpTarget>(targetSchema, target, 'http target');
  } catch (err) {
    if (err instanceof SchemaMismatchError)
      throw new InvokeError(err.message, { definitive: true });
    throw err;
  }
}

export function trackingFor(target: unknown): TrackingMode {
  return tryParse<HttpTarget>(targetSchema, target)?.tracking ?? 'sync';
}

export function idempotentFor(target: unknown): boolean {
  return tryParse<HttpTarget>(targetSchema, target)?.idempotent ?? false;
}

/** The HTTP request timeout when the target sets none (the SDK HttpClient's default). */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
/**
 * How much longer than the request timeout the core waits for `invoke`: room for reading the
 * body and the `usageFrom` expression, and so the request's own timeout (a `TransportError`
 * that says whether the request was sent) always fires first.
 */
export const INVOKE_TIMEOUT_MARGIN_SECONDS = 10;

/** `ExecutorType.invokeTimeoutFor`: the target's request timeout plus a margin. */
export function invokeTimeoutFor(target: unknown): number {
  const request =
    tryParse<HttpTarget>(targetSchema, target)?.timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.ceil(request) + INVOKE_TIMEOUT_MARGIN_SECONDS;
}
