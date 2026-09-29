import jsonata from 'jsonata';

import {
  InvokeError,
  invokeErrorForStatus,
  isTransportError,
  parseRetryAfter,
  type Destination,
  type DestinationType,
  type Health,
  type HttpResponse,
  type InvokeResult,
  type JSONSchema,
  type MeterReading,
  type PluginContext,
  type RunHandle,
  type UsageReport,
  tryParse,
} from '@ai-switchboard/sdk';

import { declaredUsage, verifySignedCallback } from './callback.js';
import {
  DEFAULT_USAGE_DIMENSIONS,
  ENDPOINT_METER_ID,
  metersFor,
  readSettings,
  settingsSchema,
  usageFor,
  type HttpSettings,
} from './settings.js';
import {
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  idempotentFor,
  INVOKE_TIMEOUT_MARGIN_SECONDS,
  inputSchema,
  invokeTimeoutFor,
  readTarget,
  targetSchema,
  trackingFor,
  type HttpTarget,
} from './target.js';

const PAUSED_STATUS = 423;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const USAGE_EXPRESSION_TIMEOUT_MS = 2_000;
const USAGE_EXPRESSION_MAX_DEPTH = 500;
const ERROR_SNIPPET_CHARS = 200;

/** Absolute URLs pass through. */
export function resolveUrl(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (baseUrl === undefined) {
    throw new InvokeError(`Relative URL "${url}" needs the instance's base URL to be set`, {
      definitive: true,
    });
  }
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Default headers carry the authorization secret: only send them to the base URL's origin. */
function defaultHeadersFor(settings: HttpSettings, url: string): Record<string, string> {
  if (settings.baseUrl === undefined) return lowerKeys(settings.headers);
  return new URL(url).origin === new URL(settings.baseUrl).origin
    ? lowerKeys(settings.headers)
    : {};
}

function parseBody(res: HttpResponse): unknown {
  const text = res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function snippet(res: HttpResponse): string {
  const text = res.text().trim();
  if (text === '') return '';
  return `: ${text.length > ERROR_SNIPPET_CHARS ? `${text.slice(0, ERROR_SNIPPET_CHARS)}…` : text}`;
}

/**
 * Map a non-2xx response. 429 is returned as `failed` with `retryAfterSeconds` (the request was
 * refused, nothing ran); 423 is `held: paused`; everything else throws an `InvokeError`.
 */
export function refusal(res: HttpResponse, now: Date, what: string): InvokeResult {
  const status = res.status;
  const retryAfter = parseRetryAfter(res.headers['retry-after'], now);
  if (status === 429) {
    return {
      status: 'failed',
      retryAfterSeconds: retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS,
      errors: [`${what} answered 429 Too Many Requests${snippet(res)}`],
    };
  }
  if (status === PAUSED_STATUS) return { status: 'held', reason: 'paused' };
  const message = `${what} answered ${status}${snippet(res)}`;
  throw invokeErrorForStatus(
    status,
    message,
    retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {},
  );
}

function externalIdOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['id', 'requestId', 'request_id']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Evaluate a `usageFrom` expression. JSONata's own `timeout` and `stack` limits are checked on
 * every step; a timer racing the evaluation cannot fire while JSONata keeps the microtask queue
 * busy, so an endless expression would block the event loop.
 */
async function evaluateUsage(
  expression: jsonata.Expression,
  data: unknown,
): Promise<Record<string, unknown>> {
  const value: unknown = await expression.evaluate(data);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageFrom must return an object of dimension id → number');
  }
  return value as Record<string, unknown>;
}

interface MeterBody {
  used: number;
  limit: number;
  resetsAt?: string;
}

const meterBodySchema: JSONSchema = {
  type: 'object',
  required: ['used', 'limit'],
  properties: {
    used: { type: 'number', minimum: 0 },
    limit: { type: 'number', exclusiveMinimum: 0 },
    resetsAt: { type: 'string', format: 'date-time' },
  },
};

function createHttpDestination(settings: HttpSettings, ctx: PluginContext): Destination {
  const declared = new Set(settings.usageDimensions.map((d) => d.id));

  // Compiled per instance: the set of expressions is bounded by this instance's targets.
  const compiled = new Map<string, jsonata.Expression>();
  function usageExpression(source: string): jsonata.Expression {
    let expression = compiled.get(source);
    if (!expression) {
      expression = jsonata(source, {
        timeout: USAGE_EXPRESSION_TIMEOUT_MS,
        stack: USAGE_EXPRESSION_MAX_DEPTH,
      });
      compiled.set(source, expression);
    }
    return expression;
  }

  async function syncUsage(
    target: HttpTarget,
    res: HttpResponse,
    body: unknown,
    durationSeconds: number,
  ): Promise<UsageReport | undefined> {
    const measured: Record<string, unknown> = {
      duration_seconds: durationSeconds,
      response_bytes: res.body.length,
    };
    if (target.usageFrom !== undefined) {
      try {
        const fromExpr = await evaluateUsage(usageExpression(target.usageFrom), {
          response: { status: res.status, headers: res.headers, body },
          durationSeconds,
        });
        Object.assign(measured, fromExpr);
      } catch (err) {
        // The work already happened; a broken usage expression must not fail the run.
        ctx.logger.warn('usageFrom evaluation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return declaredUsage(measured, declared);
  }

  return {
    async invoke(rawTarget: unknown, input: unknown, run: RunHandle): Promise<InvokeResult> {
      const target = readTarget(rawTarget);
      const url = resolveUrl(settings.baseUrl, target.url);
      const headers: Record<string, string> = {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        ...defaultHeadersFor(settings, url),
        ...lowerKeys(target.headers),
        'x-switchboard-run-id': run.id,
        'x-switchboard-callback-url': run.callbackUrl,
        ...(run.dryRun ? { 'x-switchboard-dry-run': '1' } : {}),
      };
      const sendsBody = target.method !== 'GET' && target.method !== 'DELETE';
      const started = ctx.now().getTime();
      const res = await ctx.http.request({
        method: target.method,
        url,
        headers,
        ...(sendsBody && input !== undefined ? { json: input } : {}),
        timeoutMs: Math.round((target.timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000),
      });
      const durationSeconds = Math.max(0, (ctx.now().getTime() - started) / 1000);
      if (!res.ok) return refusal(res, ctx.now(), `${target.method} ${new URL(url).host}`);

      const body = parseBody(res);
      const externalId = externalIdOf(body);
      if (target.tracking !== 'sync') {
        return { status: 'started', ...(externalId !== undefined ? { externalId } : {}) };
      }
      const usage = await syncUsage(target, res, body, Math.round(durationSeconds * 1000) / 1000);
      return {
        status: 'completed',
        result: body,
        ...(externalId !== undefined ? { externalId } : {}),
        ...(usage ? { usage } : {}),
      };
    },

    verifyCallback: (req) => verifySignedCallback(req, settings.callbackSecret, declared),

    async readMeters(): Promise<MeterReading[]> {
      if (settings.meterEndpoint === undefined) return [];
      const url = resolveUrl(settings.baseUrl, settings.meterEndpoint);
      const res = await ctx.http.get(url, {
        headers: { accept: 'application/json', ...defaultHeadersFor(settings, url) },
      });
      if (!res.ok) throw new Error(`meter endpoint answered ${res.status}`);
      const reading = tryParse<MeterBody>(meterBodySchema, parseBody(res));
      if (!reading) throw new Error('meter endpoint did not return { used, limit, resetsAt }');
      const utilization = Math.min(100, Math.max(0, (reading.used / reading.limit) * 100));
      return [
        {
          id: ENDPOINT_METER_ID,
          used: reading.used,
          limit: reading.limit,
          utilization,
          ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
          observedAt: ctx.now().toISOString(),
        },
      ];
    },

    async health(): Promise<Health> {
      const checkedAt = (): string => ctx.now().toISOString();
      if (settings.baseUrl === undefined) {
        return {
          status: 'unknown',
          message: 'No base URL configured; targets name their own URLs.',
          checkedAt: checkedAt(),
        };
      }
      const headers = defaultHeadersFor(settings, settings.baseUrl);
      try {
        let res = await ctx.http.request({ method: 'HEAD', url: settings.baseUrl, headers });
        if (res.status === 405 || res.status === 501) {
          res = await ctx.http.get(settings.baseUrl, { headers });
        }
        if (res.status === 401 || res.status === 403) {
          return {
            status: 'unhealthy',
            message: `Base URL rejected the credentials (${res.status})`,
            checkedAt: checkedAt(),
          };
        }
        if (res.status >= 500) {
          return {
            status: 'unhealthy',
            message: `Base URL answered ${res.status}`,
            checkedAt: checkedAt(),
          };
        }
        return {
          status: 'healthy',
          message: `Base URL answered ${res.status}`,
          checkedAt: checkedAt(),
        };
      } catch (err) {
        return {
          status: 'unhealthy',
          message: isTransportError(err) || err instanceof Error ? err.message : String(err),
          checkedAt: checkedAt(),
        };
      }
    },
  };
}

export const httpDestinationType: DestinationType = {
  id: 'http',
  displayName: 'HTTP',
  icon: 'link',
  description:
    'Sends one HTTP request per run to any endpoint: an internal job runner, a serverless ' +
    'function, any webhook-triggered automation.',
  settingsSchema,
  targetSchema,
  inputSchema,
  examples: [
    {
      target: {
        method: 'POST',
        url: 'https://jobs.example.com/api/triage',
        tracking: 'sync',
        idempotent: false,
        usageFrom: '{ "duration_seconds": durationSeconds }',
      },
      input: { repository: 'acme/api', issue: 42, mode: 'event' },
    },
  ],
  tracking: 'sync',
  trackingFor,
  idempotentInvoke: false,
  idempotentFor,
  invokeTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS + INVOKE_TIMEOUT_MARGIN_SECONDS,
  invokeTimeoutFor,
  usage: DEFAULT_USAGE_DIMENSIONS,
  usageFor,
  meters: [],
  metersFor,
  create: (settings, ctx) => createHttpDestination(readSettings(settings), ctx),
};
