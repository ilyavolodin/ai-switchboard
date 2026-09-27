import {
  eventTypeDefinitionSchema,
  parseWith,
  type EventTypeDefinition,
  type JSONSchema,
  type Settings,
} from '@ai-switchboard/sdk';

/** The source id, which is also the namespace of every event type an instance defines. */
export const SOURCE_ID = 'poll-http';

/** Settings after validation, with defaults applied. */
export interface PollHttpSettings {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  token?: string;
  tokenHeader: string;
  authScheme: string;
  cursorParam?: string;
  cursorIn: 'query' | 'body';
  body?: Record<string, unknown>;
  itemsExpression: string;
  mapping: string;
  cursorExpression?: string;
  initialWatermark?: string;
  healthUrl?: string;
  eventTypes: EventTypeDefinition[];
}

const REQUEST = 'Request';
const MAPPING = 'Mapping';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['url', 'eventTypes', 'mapping'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      pattern: '^https?://',
      title: 'URL',
      description: 'The JSON endpoint to poll.',
      'x-group': REQUEST,
    },
    method: {
      type: 'string',
      enum: ['GET', 'POST'],
      default: 'GET',
      title: 'Method',
      description: 'HTTP method of the poll request.',
      'x-group': REQUEST,
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      default: {},
      title: 'Headers',
      description: 'Extra request headers. Put credentials in Token, not here.',
      'x-group': REQUEST,
    },
    token: {
      type: 'string',
      title: 'Token',
      description:
        'Credential sent with every request (as `<scheme> <token>` in Authorization by default).',
      'x-secret': true,
      'x-group': 'Authentication',
    },
    tokenHeader: {
      type: 'string',
      default: 'authorization',
      title: 'Token header',
      description:
        'Header that carries the token. For `authorization` the scheme is prepended; any other header (e.g. `x-api-key`) gets the bare token.',
      'x-group': 'Authentication',
    },
    authScheme: {
      type: 'string',
      default: 'Bearer',
      title: 'Auth scheme',
      description:
        'Scheme before the token in the Authorization header, e.g. `Bearer` or `Token`. Empty for none.',
      'x-group': 'Authentication',
    },
    cursorParam: {
      type: 'string',
      title: 'Cursor parameter',
      description:
        'Name of the parameter that carries the watermark, e.g. `since` or `updated_after`.',
      'x-group': 'Cursor',
    },
    cursorIn: {
      type: 'string',
      enum: ['query', 'body'],
      default: 'query',
      title: 'Cursor location',
      description: 'Send the cursor as a query parameter or as a field of the JSON body (POST).',
      'x-group': 'Cursor',
    },
    body: {
      type: 'object',
      title: 'Request body',
      description:
        'JSON body for POST requests; the cursor field is merged in when cursor location is body.',
      'x-widget': 'json',
      'x-group': REQUEST,
    },
    initialWatermark: {
      type: 'string',
      title: 'Initial watermark',
      description:
        'Cursor for the very first poll, e.g. an ISO timestamp. When it is a timestamp, older items are skipped.',
      'x-group': 'Cursor',
    },
    cursorExpression: {
      type: 'string',
      title: 'Cursor expression',
      description:
        'JSONata over `{ response, items, watermark }` giving the next cursor string. Default: the latest mapped `occurredAt`.',
      'x-widget': 'expression',
      'x-group': 'Cursor',
    },
    itemsExpression: {
      type: 'string',
      default: '$',
      title: 'Items expression',
      description:
        'JSONata over the response body giving the array of items, e.g. `data.incidents`.',
      'x-widget': 'expression',
      'x-group': MAPPING,
    },
    mapping: {
      type: 'string',
      minLength: 1,
      title: 'Mapping',
      description:
        'JSONata over `{ item, response }` yielding one object or an array of `{ type, artifact: { kind, id, url?, version? }, attributes, occurredAt?, deliveryId? }`.',
      'x-widget': 'expression',
      'x-group': MAPPING,
    },
    eventTypes: {
      type: 'array',
      minItems: 1,
      items: eventTypeDefinitionSchema(SOURCE_ID, 'poll-http.incident.opened'),
      title: 'Event types',
      description: 'The event types this instance produces, each with its flat attributes.',
      'x-group': 'Event types',
    },
    healthUrl: {
      type: 'string',
      format: 'uri',
      pattern: '^https?://',
      title: 'Health URL',
      description:
        'Optional cheap endpoint (same credentials) checked by health(). Without it, health is unknown.',
      'x-group': REQUEST,
    },
  },
};

/** Thrown by `create` when the instance settings are unusable. */
export class PollHttpSettingsError extends Error {
  override readonly name = 'PollHttpSettingsError';
}

/** Validate settings against the schema (on a copy, so defaults do not leak back) and narrow. */
export function readSettings(settings: Settings): PollHttpSettings {
  return parseWith<PollHttpSettings>(settingsSchema, settings, 'poll-http settings', {
    error: PollHttpSettingsError,
  });
}
