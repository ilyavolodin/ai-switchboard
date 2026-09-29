import {
  asArray,
  asObject,
  asString,
  checkHealth,
  tryJson,
  verifySharedSecretHeader,
  withSettings,
  type ArtifactRef,
  type ArtifactSnapshot,
  type Health,
  type PluginContext,
  type Source,
  type SourceType,
} from '@ai-switchboard/sdk';

import { createApi, DatadogApiError, errorText } from './api.js';
import { eventTypes } from './events.js';
import { parseDelivery } from './parse.js';
import {
  apiHost,
  appHost,
  DatadogSettingsError,
  settingsSchema,
  SITES,
  type DatadogSettings,
} from './settings.js';

export { DatadogApiError } from './api.js';

function createDatadogSource(s: DatadogSettings, ctx: PluginContext): Source {
  const api = createApi(ctx.http, s);
  const hasKeys = (s.apiKey ?? '') !== '' && (s.appKey ?? '') !== '';

  async function resolve(ref: ArtifactRef): Promise<ArtifactSnapshot | null> {
    if (ref.kind !== 'datadog.monitor')
      throw new DatadogApiError(`datadog cannot look up ${ref.kind}`);
    if (!hasKeys) throw new DatadogApiError('resolve needs the apiKey and appKey settings');
    if (!/^[0-9]+$/.test(ref.id)) return null;
    const res = await api.monitor(ref.id);
    if (res.status === 404) return null;
    const body = asObject(tryJson(res));
    if (!res.ok || !body)
      throw new DatadogApiError(`Datadog answered ${res.status}: ${errorText(body, res.status)}`);
    const url = `https://${appHost(s.site)}/monitors/${ref.id}`;
    const priority = body.priority;
    return {
      ref: { kind: 'datadog.monitor', id: ref.id, url },
      name: asString(body.name) ?? '',
      overallState: asString(body.overall_state) ?? '',
      tags: asArray(body.tags).filter((t): t is string => typeof t === 'string'),
      priority: typeof priority === 'number' ? `P${priority}` : null,
      url,
    };
  }

  function health(): Promise<Health> {
    return checkHealth(ctx, async () => {
      if ((s.apiKey ?? '') === '') {
        return {
          status: 'unknown',
          message: 'No API key configured; the source only receives webhooks.',
        };
      }
      const res = await api.validate();
      return res.ok
        ? { status: 'healthy', message: `API key valid on ${s.site}` }
        : { status: 'unhealthy', message: `Datadog answered ${res.status} validating the API key` };
    });
  }

  return {
    verify: (req) =>
      verifySharedSecretHeader(req, { header: s.headerName, secret: s.sharedSecret }),
    parse: (req) => parseDelivery(req),
    resolve,
    health,
  };
}

export const datadogSource: SourceType = {
  id: 'datadog',
  displayName: 'Datadog',
  icon: 'alert',
  description:
    'Datadog monitor notifications through a webhook integration, authenticated by a shared-secret header.',
  mode: 'push',
  settingsSchema,
  eventTypes,
  create: withSettings(settingsSchema, 'datadog settings', createDatadogSource, {
    error: DatadogSettingsError,
  }),
};

export const API_HOSTS = SITES.map(apiHost);
