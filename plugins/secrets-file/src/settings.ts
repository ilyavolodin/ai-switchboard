import type { JSONSchema } from '@ai-switchboard/sdk';

export interface FileSecretSettings {
  /** One file per secret: `secret://file/github-token` reads `<directory>/github-token`. */
  directory: string;
  /**
   * Lets the host store rotated instance credentials here (SDK 2.2). Off by default: a mounted
   * Kubernetes secret is read-only.
   */
  writable?: boolean;
}

export const DEFAULT_DIRECTORY = '/run/secrets';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Mounted files',
  description:
    'Resolves secret://file/<name> from files in a directory (Docker and Kubernetes secrets).',
  properties: {
    directory: {
      type: 'string',
      minLength: 1,
      pattern: '^/',
      default: DEFAULT_DIRECTORY,
      title: 'Directory',
      description: 'Absolute path of the directory holding one file per secret.',
      'x-group': 'Lookup',
    },
    writable: {
      type: 'boolean',
      default: false,
      title: 'Store rotated credentials',
      description:
        'Let Switchboard write here the credentials instances rotate (for example an OAuth refresh token). The directory must be writable and persistent, not a read-only secret mount.',
      'x-group': 'Writes',
    },
  },
};
