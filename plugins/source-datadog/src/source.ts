import {
  safeEqual,
  type ArtifactRef,
  type ArtifactSnapshot,
  type Health,
  type PluginContext,
  type RawRequest,
  type Settings,
  type Source,
  type SourceType,
  type VerifyResult,
} from '@ai-switchboard/sdk';

import { eventTypes } from './events.js';
import { arr, obj, str, type Json } from './json.js';
import { parseDelivery } from './parse.js';
import {
  apiHost,
  appHost,
  readSettings,
  settingsSchema,
  SITES,
  type DatadogSettings,
} from './settings.js';

/** Thrown when an API call needs keys the instance was not given, or Datadog refuses. */
export class DatadogApiError extends Error {
  override readonly name = 'DatadogApiError';
}

function verifySecret(s: DatadogSettings, req: RawRequest): VerifyResult {
  const header = s.headerName.toLowerCase();
  const given = req.headers[header];
  if (given === undefined || given === '') return { ok: false, reason: `missing ${header} header` };
  return safeEqual(given, s.sharedSecret) ? { ok: true } : { ok: false, reason: 'secret mismatch' };
}

function errorText(body: Json | undefined, status: number): string {
  const errors = arr(body?.errors).filter((e): e is string => typeof e === 'string');
  return errors.length > 0 ? errors.join('; ') : `HTTP ${status}`;
}

function createDatadogSource(settings: Settings, ctx: PluginContext): Source {
  const s = readSettings(settings);
  const base = `https://${apiHost(s.site)}`;
  const hasKeys = (s.apiKey ?? '') !== '' && (s.appKey ?? '') !== '';

  function headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'dd-api-key': s.apiKey ?? '',
      ...(s.appKey !== undefined && s.appKey !== '' ? { 'dd-application-key': s.appKey } : {}),
    };
  }

  async function resolve(ref: ArtifactRef): Promise<ArtifactSnapshot | null> {
    if (ref.kind !== 'datadog.monitor')
      throw new DatadogApiError(`datadog cannot look up ${ref.kind}`);
    if (!hasKeys) throw new DatadogApiError('resolve needs the apiKey and appKey settings');
    if (!/^[0-9]+$/.test(ref.id)) return null;
    const res = await ctx.http.get(`${base}/api/v1/monitor/${ref.id}`, { headers: headers() });
    if (res.status === 404) return null;
    let body: Json | undefined;
    try {
      body = obj(res.json());
    } catch {
      body = undefined;
    }
    if (!res.ok || !body)
      throw new DatadogApiError(`Datadog answered ${res.status}: ${errorText(body, res.status)}`);
    const url = `https://${appHost(s.site)}/monitors/${ref.id}`;
    const priority = body.priority;
    return {
      ref: { kind: 'datadog.monitor', id: ref.id, url },
      name: str(body.name) ?? '',
      overallState: str(body.overall_state) ?? '',
      tags: arr(body.tags).filter((t): t is string => typeof t === 'string'),
      priority: typeof priority === 'number' ? `P${priority}` : null,
      url,
    };
  }

  async function health(): Promise<Health> {
    const checkedAt = ctx.now().toISOString();
    if ((s.apiKey ?? '') === '') {
      return {
        status: 'unknown',
        message: 'No API key configured; the source only receives webhooks.',
        checkedAt,
      };
    }
    try {
      const res = await ctx.http.get(`${base}/api/v1/validate`, { headers: headers() });
      return res.ok
        ? { status: 'healthy', message: `API key valid on ${s.site}`, checkedAt }
        : {
            status: 'unhealthy',
            message: `Datadog answered ${res.status} validating the API key`,
            checkedAt,
          };
    } catch (err) {
      return {
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }

  return {
    verify: (req) => verifySecret(s, req),
    parse: (req) => parseDelivery(req),
    resolve,
    health,
  };
}

export const datadogSource: SourceType = {
  id: 'datadog',
  displayName: 'Datadog',
  description:
    'Datadog monitor notifications through a webhook integration, authenticated by a shared-secret header.',
  mode: 'push',
  settingsSchema,
  eventTypes,
  create: createDatadogSource,
};

/** Every API host a Datadog instance may call, for the plugin's network capability. */
export const API_HOSTS = SITES.map(apiHost);
