import type { JSONSchema } from '@ai-switchboard/sdk';

export interface EnvSecretSettings {
  /** Prepended to every name: `secret://env/GITHUB_TOKEN` with prefix `SB_` reads `SB_GITHUB_TOKEN`. */
  prefix: string;
  /**
   * Comma-separated globs (`*` matches any run of characters) that narrow what `list()` shows,
   * matched against the name after the prefix is stripped. Empty shows everything. Resolution is
   * not affected.
   */
  include: string;
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
    include: {
      type: 'string',
      pattern: '^[A-Za-z0-9_*, ]*$',
      default: '',
      title: 'Listed names',
      description:
        'Comma-separated globs that narrow the names shown under Secrets, e.g. GITHUB_*,SLACK_*. Matched after the prefix is stripped; empty shows every name. Resolution is not affected.',
      'x-group': 'Listing',
    },
  },
};
