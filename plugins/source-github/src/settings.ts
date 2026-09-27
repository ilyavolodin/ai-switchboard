import { parseWith, type JSONSchema, type Settings } from '@ai-switchboard/sdk';

/** Settings after validation, with defaults applied. */
export interface GitHubSettings {
  authMode: 'app' | 'token';
  appId?: string;
  privateKey?: string;
  installationId?: string;
  token?: string;
  owner: string;
  repositories: string[];
  webhookSecret: string;
}

const AUTH = 'Authentication';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['owner', 'webhookSecret'],
  properties: {
    authMode: {
      type: 'string',
      enum: ['app', 'token'],
      default: 'token',
      title: 'Authentication',
      description: 'A GitHub App installation (recommended) or a personal access token.',
      'x-group': AUTH,
    },
    appId: {
      type: 'string',
      pattern: '^[0-9]+$',
      title: 'App id',
      description: 'The GitHub App’s numeric id (App settings → General).',
      'x-group': AUTH,
    },
    privateKey: {
      type: 'string',
      title: 'App private key',
      description: 'The App’s PEM private key. Used only to sign short-lived JWTs.',
      'x-secret': true,
      'x-widget': 'textarea',
      'x-group': AUTH,
    },
    installationId: {
      type: 'string',
      pattern: '^[0-9]+$',
      title: 'Installation id',
      description:
        'The numeric id of the App’s installation on the owner (from the installation URL).',
      'x-group': AUTH,
    },
    token: {
      type: 'string',
      title: 'Personal access token',
      description: 'A fine-grained or classic token with the scopes listed in the README.',
      'x-secret': true,
      'x-group': AUTH,
    },
    owner: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9-]+$',
      title: 'Owner',
      description: 'The organization (or user) whose repositories this instance covers.',
      'x-group': 'Scope',
    },
    repositories: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      default: [],
      title: 'Repositories',
      description:
        'Optional allowlist (`api` or `acme/api`). Events from other repositories are ignored, and Register webhook creates repository hooks instead of an organization hook.',
      'x-group': 'Scope',
    },
    webhookSecret: {
      type: 'string',
      minLength: 1,
      title: 'Webhook secret',
      description: 'The secret GitHub signs deliveries with (X-Hub-Signature-256).',
      'x-secret': true,
      'x-group': 'Webhook',
    },
  },
  allOf: [
    {
      if: { properties: { authMode: { const: 'app' } }, required: ['authMode'] },
      then: { required: ['appId', 'privateKey', 'installationId'] },
      else: { required: ['token'], properties: { token: { minLength: 1 } } },
    },
  ],
};

export class GitHubSettingsError extends Error {
  override readonly name = 'GitHubSettingsError';
}

/** Validate settings against the schema (on a copy, so defaults do not leak back) and narrow. */
export function readSettings(settings: Settings): GitHubSettings {
  return parseWith<GitHubSettings>(settingsSchema, settings, 'github settings', {
    error: GitHubSettingsError,
  });
}
