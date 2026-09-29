import type { JSONSchema } from '@ai-switchboard/sdk';

export const SITES = [
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
] as const;
export type Site = (typeof SITES)[number];

export function apiHost(site: Site): string {
  return `api.${site}`;
}

/** US1 and EU use `app.`; the others do not. */
export function appHost(site: Site): string {
  return site === 'datadoghq.com' || site === 'datadoghq.eu' ? `app.${site}` : site;
}

export interface DatadogSettings {
  headerName: string;
  sharedSecret: string;
  site: Site;
  apiKey?: string;
  appKey?: string;
}

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['sharedSecret'],
  properties: {
    headerName: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9-]+$',
      default: 'x-switchboard-secret',
      title: 'Secret header',
      description: 'Custom header you add to the Datadog webhook; it carries the shared secret.',
      'x-group': 'Webhook',
    },
    sharedSecret: {
      type: 'string',
      minLength: 16,
      title: 'Shared secret',
      description:
        'A long random value, also pasted into the Datadog webhook’s custom headers. At least 16 characters.',
      'x-secret': true,
      'x-group': 'Webhook',
    },
    site: {
      type: 'string',
      enum: [...SITES],
      default: 'datadoghq.com',
      title: 'Datadog site',
      description: 'The site your organization is on (the host you log in to).',
      'x-group': 'API (optional)',
    },
    apiKey: {
      type: 'string',
      title: 'API key',
      description: 'Only needed for live monitor state (resolve) and health checks.',
      'x-secret': true,
      'x-group': 'API (optional)',
    },
    appKey: {
      type: 'string',
      title: 'Application key',
      description: 'Needed with the API key for resolve; scope it to `monitors_read`.',
      'x-secret': true,
      'x-group': 'API (optional)',
    },
  },
};

export class DatadogSettingsError extends Error {
  override readonly name = 'DatadogSettingsError';
}
