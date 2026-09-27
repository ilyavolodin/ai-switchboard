import { compileSchema, formatErrors, type JSONSchema, type Settings } from '@ai-switchboard/sdk';

/** Settings after validation, with defaults applied. */
export interface LinearSettings {
  apiKey: string;
  webhookSecret: string;
  teamKeys: string[];
}

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['apiKey', 'webhookSecret'],
  properties: {
    apiKey: {
      type: 'string',
      minLength: 1,
      title: 'API key',
      description:
        'A Linear personal API key (Settings → Security & access) or an OAuth token (`Bearer …`). Used for live state, actions and Register webhook.',
      'x-secret': true,
      'x-group': 'Authentication',
    },
    webhookSecret: {
      type: 'string',
      minLength: 1,
      title: 'Webhook signing secret',
      description: 'The secret Linear signs deliveries with (Linear-Signature).',
      'x-secret': true,
      'x-group': 'Webhook',
    },
    teamKeys: {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Za-z0-9]+$' },
      default: [],
      title: 'Teams',
      description:
        'Optional team keys (e.g. `LOL`). Events from other teams are ignored, and Register webhook creates one webhook per team instead of one for all public teams.',
      'x-group': 'Scope',
    },
  },
};

export class LinearSettingsError extends Error {
  override readonly name = 'LinearSettingsError';
}

/** Validate settings against the schema (on a copy, so defaults do not leak back) and narrow. */
export function readSettings(settings: Settings): LinearSettings {
  const copy = structuredClone(settings);
  const validate = compileSchema(settingsSchema);
  if (!validate(copy)) {
    throw new LinearSettingsError(
      `Invalid linear settings: ${formatErrors(validate.errors).join('; ')}`,
    );
  }
  return copy as unknown as LinearSettings;
}
