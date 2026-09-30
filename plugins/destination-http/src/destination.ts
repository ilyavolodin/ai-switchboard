import {
  asObject,
  checkHealth,
  InvokeError,
  lowerCaseHeaders,
  meterReading,
  parseDefinitive,
  refusalFor,
  responseSnippet,
  SWITCHBOARD_RUN_ID_HEADER,
  tryJson,
  tryParse,
  withSettings,
  type Destination,
  type DestinationType,
  type HttpResponse,
  type InvokeResult,
  type JSONSchema,
  type MeterReading,
  type PluginContext,
  type RunHandle,
} from '@ai-switchboard/sdk';

import { verifySignedCallback } from './callback.js';
import {
  DEFAULT_USAGE_DIMENSIONS,
  ENDPOINT_METER_ID,
  metersFor,
  settingsSchema,
  usageFor,
  validateSettings,
  type HttpSettings,
} from './settings.js';
import {
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  idempotentFor,
  INVOKE_TIMEOUT_MARGIN_SECONDS,
  inputSchema,
  invokeTimeoutFor,
  targetSchema,
  trackingFor,
  type HttpTarget,
} from './target.js';
import { createUsageMeasurer } from './usage.js';

const PAUSED_STATUS = 423;

/** Thrown when the meter endpoint cannot be read; the core shows the meter as stale. */
export class MeterEndpointError extends Error {
  override readonly name = 'MeterEndpointError';
}

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

/** Default headers carry the authorization secret: only send them to the base URL's origin. */
function defaultHeadersFor(settings: HttpSettings, url: string): Record<string, string> {
  if (settings.baseUrl === undefined) return lowerCaseHeaders(settings.headers);
  return new URL(url).origin === new URL(settings.baseUrl).origin
    ? lowerCaseHeaders(settings.headers)
    : {};
}

function parseBody(res: HttpResponse): unknown {
  const text = res.text();
  if (text === '') return null;
  return tryJson(res) ?? text;
}

function snippet(res: HttpResponse): string {
  const text = responseSnippet(res);
  return text === '' ? '' : `: ${text}`;
}

/**
 * Map a non-2xx response. 429 is returned as `failed` with `retryAfterSeconds` (the request was
 * refused, nothing ran); 423 is `held: paused`; everything else throws an `InvokeError`.
 */
export function refusal(res: HttpResponse, now: Date, what: string): InvokeResult {
  return refusalFor(res, now, {
    message: (r) => `${what} answered ${r.status}${snippet(r)}`,
    rateLimitMessage: (r) => `${what} answered 429 Too Many Requests${snippet(r)}`,
    held: (r) => (r.status === PAUSED_STATUS ? 'paused' : undefined),
  });
}

function externalIdOf(body: unknown): string | undefined {
  const record = asObject(body);
  if (!record) return undefined;
  for (const key of ['id', 'requestId', 'request_id']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
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
  const usage = createUsageMeasurer(declared, ctx.logger);

  return {
    async invoke(rawTarget: unknown, input: unknown, run: RunHandle): Promise<InvokeResult> {
      const target = parseDefinitive<HttpTarget>(targetSchema, rawTarget, 'http target');
      const url = resolveUrl(settings.baseUrl, target.url);
      const headers: Record<string, string> = {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        ...defaultHeadersFor(settings, url),
        ...lowerCaseHeaders(target.headers),
        [SWITCHBOARD_RUN_ID_HEADER]: run.id,
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
      const measured = await usage.measure(
        target,
        { res, body, durationSeconds: Math.round(durationSeconds * 1000) / 1000 },
        ctx.now(),
      );
      return {
        status: 'completed',
        result: body,
        ...(externalId !== undefined ? { externalId } : {}),
        ...(measured ? { usage: measured } : {}),
      };
    },

    verifyCallback: (req) => verifySignedCallback(req, settings.callbackSecret, declared),

    async readMeters(): Promise<MeterReading[]> {
      if (settings.meterEndpoint === undefined) return [];
      const url = resolveUrl(settings.baseUrl, settings.meterEndpoint);
      const res = await ctx.http.get(url, {
        headers: { accept: 'application/json', ...defaultHeadersFor(settings, url) },
      });
      if (!res.ok) throw new MeterEndpointError(`meter endpoint answered ${res.status}`);
      const reading = tryParse<MeterBody>(meterBodySchema, parseBody(res));
      if (!reading) {
        throw new MeterEndpointError('meter endpoint did not return { used, limit, resetsAt }');
      }
      return [
        meterReading({
          id: ENDPOINT_METER_ID,
          used: reading.used,
          limit: reading.limit,
          ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
          observedAt: ctx.now().toISOString(),
        }),
      ];
    },

    health: () =>
      checkHealth(ctx, async () => {
        if (settings.baseUrl === undefined) {
          return {
            status: 'unknown',
            message: 'No base URL configured; targets name their own URLs.',
          };
        }
        const headers = defaultHeadersFor(settings, settings.baseUrl);
        let res = await ctx.http.request({ method: 'HEAD', url: settings.baseUrl, headers });
        if (res.status === 405 || res.status === 501) {
          res = await ctx.http.get(settings.baseUrl, { headers });
        }
        if (res.status === 401 || res.status === 403) {
          return {
            status: 'unhealthy',
            message: `Base URL rejected the credentials (${res.status})`,
          };
        }
        if (res.status >= 500) {
          return { status: 'unhealthy', message: `Base URL answered ${res.status}` };
        }
        return { status: 'healthy', message: `Base URL answered ${res.status}` };
      }),
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
  create: withSettings(settingsSchema, 'http destination settings', (s: HttpSettings, ctx) =>
    createHttpDestination(validateSettings(s), ctx),
  ),
};
