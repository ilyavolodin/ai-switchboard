import {
  parseWith,
  tryParse,
  type JSONSchema,
  type MeterSpec,
  type Settings,
  type UsageDimension,
} from '@ai-switchboard/sdk';

/** Where the seat's usage windows are read from (all optional: without a refresh token, no meters). */
export interface RoutinesUsageSettings {
  oauthRefreshToken?: string;
  oauthClientId: string;
  oauthTokenUrl: string;
  usageUrl: string;
  /** Typed-in limit for the estimated `daily_runs` meter. */
  dailyRunLimit: number;
}

/** Instance settings of the `claude-routines` executor, after secrets are resolved. */
export interface RoutinesSettings {
  apiBaseUrl: string;
  /** The routine's API trigger bearer token. */
  token: string;
  /** Sent as `anthropic-beta`. */
  betaHeader: string;
  /** Shared secret the routine's completion step signs its callback with. */
  callbackSecret: string;
  usage: RoutinesUsageSettings;
}

export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com';
/** The dated beta the Routines trigger API is served under; configurable because it moves. */
export const DEFAULT_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
export const DEFAULT_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const DEFAULT_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Claude Code's public OAuth client id (not a secret). */
export const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const DEFAULT_DAILY_RUN_LIMIT = 15;

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Claude Routines executor',
  description: 'Fires Claude Code routines through their API trigger.',
  required: ['token', 'callbackSecret'],
  properties: {
    apiBaseUrl: {
      type: 'string',
      format: 'uri',
      pattern: '^https://',
      default: DEFAULT_API_BASE_URL,
      title: 'API base URL',
      description: 'Anthropic API origin.',
      'x-group': 'Routine trigger',
    },
    token: {
      type: 'string',
      minLength: 1,
      title: 'Trigger token',
      description:
        "The routine's API trigger bearer token (shown once when the API trigger is added to the routine).",
      'x-secret': true,
      'x-group': 'Routine trigger',
    },
    betaHeader: {
      type: 'string',
      minLength: 1,
      default: DEFAULT_BETA_HEADER,
      title: 'Beta header',
      description:
        'Value of the `anthropic-beta` header for the fire endpoint. Change it when Anthropic moves the dated beta.',
      'x-group': 'Routine trigger',
    },
    callbackSecret: {
      type: 'string',
      minLength: 16,
      title: 'Callback secret',
      description:
        "Shared secret the routine's completion step uses to sign its callback (HMAC-SHA256 of the raw body).",
      'x-secret': true,
      'x-group': 'Callbacks',
    },
    usage: {
      type: 'object',
      title: 'Seat usage',
      description:
        "Reads the seat's 5-hour and 7-day windows. Leave the refresh token empty to use estimated meters only.",
      'x-group': 'Meters',
      default: {},
      properties: {
        oauthRefreshToken: {
          type: 'string',
          minLength: 1,
          title: 'OAuth refresh token',
          description:
            "The seat's Claude OAuth refresh token. Rotated tokens are kept in the instance state.",
          'x-secret': true,
        },
        oauthClientId: {
          type: 'string',
          minLength: 1,
          default: DEFAULT_OAUTH_CLIENT_ID,
          title: 'OAuth client id',
          description: 'Client id the refresh token was issued to (Claude Code by default).',
        },
        oauthTokenUrl: {
          type: 'string',
          format: 'uri',
          default: DEFAULT_OAUTH_TOKEN_URL,
          title: 'OAuth token URL',
          description: 'Where the refresh token is exchanged for an access token.',
        },
        usageUrl: {
          type: 'string',
          format: 'uri',
          default: DEFAULT_USAGE_URL,
          title: 'Usage URL',
          description:
            "The (undocumented) endpoint Claude Code's /usage reads. If it changes, meters fall back to estimates.",
        },
        dailyRunLimit: {
          type: 'integer',
          minimum: 1,
          default: DEFAULT_DAILY_RUN_LIMIT,
          title: 'Daily routine runs',
          description:
            "Your plan's daily routine run allowance, for the estimated `daily_runs` meter.",
        },
      },
    },
  },
};

export function readSettings(settings: Settings): RoutinesSettings {
  return parseWith<RoutinesSettings>(settingsSchema, settings, 'claude-routines settings');
}

const TOKEN_DIMENSION = { unit: 'tokens', aggregate: 'sum', budgetable: true } as const;

export const USAGE_DIMENSIONS: UsageDimension[] = [
  { id: 'input_tokens', title: 'Input tokens', ...TOKEN_DIMENSION },
  { id: 'output_tokens', title: 'Output tokens', ...TOKEN_DIMENSION },
  { id: 'cache_read_tokens', title: 'Cache read tokens', ...TOKEN_DIMENSION },
  { id: 'cache_write_tokens', title: 'Cache write tokens', ...TOKEN_DIMENSION },
  {
    id: 'duration_seconds',
    title: 'Duration',
    unit: 'seconds',
    aggregate: 'sum',
    budgetable: true,
  },
];

export const FIVE_HOUR = 'five_hour';
export const SEVEN_DAY = 'seven_day';
export const DAILY_RUNS = 'daily_runs';

function meters(dailyRunLimit: number): MeterSpec[] {
  return [
    { id: FIVE_HOUR, title: '5-hour window', kind: 'window', unit: '%', primary: true },
    { id: SEVEN_DAY, title: '7-day window', kind: 'window', unit: '%' },
    {
      id: DAILY_RUNS,
      title: 'Daily routine runs',
      kind: 'allowance',
      unit: 'runs',
      estimate: { period: 'day', defaultLimit: dailyRunLimit },
    },
  ];
}

export const METERS = meters(DEFAULT_DAILY_RUN_LIMIT);

/** The instance's meters: the daily-run estimate uses the instance's typed-in limit. */
export function metersFor(settings: Settings): MeterSpec[] {
  const parsed = tryParse<RoutinesSettings>(settingsSchema, settings);
  return meters(parsed?.usage.dailyRunLimit ?? DEFAULT_DAILY_RUN_LIMIT);
}
