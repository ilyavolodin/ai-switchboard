import {
  parseWith,
  type JSONSchema,
  type MeterSpec,
  type Settings,
  type UsageDimension,
} from '@ai-switchboard/sdk';

export interface GithubActionsSettings {
  /** `app`: a GitHub App installation token (recommended). `token`: a fine-grained PAT. */
  auth: 'app' | 'token';
  /** App ID (or Client ID). */
  appId?: string | number;
  privateKey?: string;
  installationId?: string | number;
  token?: string;
}

export const GITHUB_API = 'https://api.github.com';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'GitHub Actions destination',
  description: 'Dispatches workflow_dispatch workflows and tracks their runs.',
  properties: {
    auth: {
      enum: ['app', 'token'],
      default: 'app',
      title: 'Authentication',
      description:
        'app: a GitHub App installation (Actions: read & write, Contents: read). token: a fine-grained personal access token with the same permissions.',
      'x-group': 'Authentication',
    },
    appId: {
      type: ['string', 'integer'],
      pattern: '^[A-Za-z0-9.]+$',
      title: 'App ID',
      description: "The GitHub App's App ID (or Client ID).",
      'x-group': 'GitHub App',
    },
    privateKey: {
      type: 'string',
      minLength: 1,
      title: 'Private key',
      description: "The App's private key (PEM). Used to sign short-lived JWTs.",
      'x-secret': true,
      'x-widget': 'textarea',
      'x-group': 'GitHub App',
    },
    installationId: {
      type: ['string', 'integer'],
      pattern: '^[0-9]+$',
      title: 'Installation ID',
      description:
        'The installation of the App on the organization or account that owns the repositories.',
      'x-group': 'GitHub App',
    },
    token: {
      type: 'string',
      minLength: 1,
      title: 'Token',
      description: 'A fine-grained personal access token (Actions: read & write, Contents: read).',
      'x-secret': true,
      'x-group': 'Token',
    },
  },
  allOf: [
    {
      if: { properties: { auth: { const: 'token' } }, required: ['auth'] },
      then: { required: ['token'] },
      else: { required: ['appId', 'privateKey', 'installationId'] },
    },
  ],
};

export function readSettings(settings: Settings): GithubActionsSettings {
  return parseWith<GithubActionsSettings>(settingsSchema, settings, 'github-actions settings');
}

export const OS_KEYS = ['UBUNTU', 'MACOS', 'WINDOWS'] as const;
export type RunnerOs = (typeof OS_KEYS)[number];

export const osDimension = (os: RunnerOs): string => `billable_minutes_${os.toLowerCase()}`;

const minutes = { unit: 'minutes', aggregate: 'sum', budgetable: true } as const;

export const USAGE_DIMENSIONS: UsageDimension[] = [
  { id: 'billable_minutes', title: 'Billable minutes', ...minutes },
  { id: osDimension('UBUNTU'), title: 'Billable minutes (Linux)', ...minutes },
  { id: osDimension('MACOS'), title: 'Billable minutes (macOS)', ...minutes },
  { id: osDimension('WINDOWS'), title: 'Billable minutes (Windows)', ...minutes },
  {
    id: 'duration_seconds',
    title: 'Duration',
    unit: 'seconds',
    aggregate: 'sum',
    budgetable: true,
  },
  { id: 'jobs', title: 'Jobs', unit: 'count', aggregate: 'sum', budgetable: false },
];

export const RATE_LIMIT_METER = 'api_rate_limit';

export const METERS: MeterSpec[] = [
  {
    id: RATE_LIMIT_METER,
    title: 'GitHub API rate limit',
    kind: 'window',
    unit: 'requests',
    primary: true,
  },
];
