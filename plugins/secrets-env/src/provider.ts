import type {
  Health,
  JSONSchema,
  PluginContext,
  SecretProvider,
  SecretProviderType,
  Settings,
} from '@ai-switchboard/sdk';

import { parseWith } from './validate.js';

/** Settings of the `env` secret provider. */
export interface EnvSecretSettings {
  /** Prepended to every name: `secret://env/GITHUB_TOKEN` with prefix `SB_` reads `SB_GITHUB_TOKEN`. */
  prefix: string;
}

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Environment variables',
  description: 'Resolves secret://env/<NAME> from the process environment.',
  properties: {
    prefix: {
      type: 'string',
      pattern: '^[A-Za-z0-9_]*$',
      default: '',
      title: 'Prefix',
      description:
        'Prepended to every name, e.g. SWITCHBOARD_SECRET_ makes secret://env/GITHUB_TOKEN read SWITCHBOARD_SECRET_GITHUB_TOKEN.',
      'x-group': 'Lookup',
    },
  },
};

/** The named secret does not exist. The message names the variable, never a value. */
export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function createEnvProvider(settings: EnvSecretSettings, ctx: PluginContext): SecretProvider {
  return {
    resolve(name: string): Promise<string> {
      if (!NAME.test(name)) {
        return Promise.reject(
          new SecretNotFoundError(`"${name}" is not a valid environment variable name`),
        );
      }
      const variable = `${settings.prefix}${name}`;
      const value = process.env[variable];
      if (value === undefined || value === '') {
        return Promise.reject(
          new SecretNotFoundError(`Environment variable ${variable} is not set or is empty`),
        );
      }
      return Promise.resolve(value);
    },
    health: (): Promise<Health> =>
      Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() }),
  };
}

export const envSecretProviderType: SecretProviderType = {
  id: 'env',
  displayName: 'Environment variables',
  description: 'Reads secrets from environment variables of the Switchboard process.',
  settingsSchema,
  create: (settings: Settings, ctx: PluginContext) =>
    createEnvProvider(parseWith<EnvSecretSettings>(settingsSchema, settings, 'env settings'), ctx),
};
