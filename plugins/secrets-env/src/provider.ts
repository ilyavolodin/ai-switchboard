import type {
  Health,
  JSONSchema,
  PluginContext,
  SecretListing,
  SecretProvider,
  SecretProviderType,
  Settings,
} from '@ai-switchboard/sdk';

import { parseWith } from './validate.js';

/** Settings of the `env` secret provider. */
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

/**
 * Variables that are never secrets (shell, locale, runtime and tool plumbing). Without a prefix
 * they are left out of `list()` so the Secrets view shows the variables someone set on purpose.
 */
export const SYSTEM_VARIABLES: readonly string[] = [
  '_',
  'PATH',
  'HOME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'TERM',
  'TERM_*',
  'COLORTERM',
  'COLUMNS',
  'LINES',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'MAIL',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS*',
  'MANPATH',
  'INFOPATH',
  'DISPLAY',
  'PS1',
  'PS2',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'XDG_*',
  'NODE',
  'NODE_*',
  'npm_*',
  'NPM_CONFIG_*',
  'NVM_*',
  'PNPM_*',
  'COREPACK_*',
  'INIT_CWD',
  'YARN_*',
  'HOMEBREW_*',
  'VSCODE_*',
  'ITERM_*',
  'Apple_*',
  '__CF*',
  'SECURITYSESSIONID',
  'CI',
  'KUBERNETES_SERVICE_*',
  'KUBERNETES_PORT*',
];

function globToRegExp(globs: readonly string[]): RegExp | null {
  const parts = globs
    .map((g) => g.trim())
    .filter((g) => g !== '')
    .map((g) =>
      g
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*'),
    );
  return parts.length === 0 ? null : new RegExp(`^(?:${parts.join('|')})$`);
}

const SYSTEM = globToRegExp(SYSTEM_VARIABLES);

/** The named secret does not exist. The message names the variable, never a value. */
export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function createEnvProvider(settings: EnvSecretSettings, ctx: PluginContext): SecretProvider {
  const include = globToRegExp(settings.include.split(','));
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
    // Names only: the value is read solely to leave out empty variables, which resolve rejects.
    list(): Promise<SecretListing[]> {
      const names: string[] = [];
      for (const [variable, value] of Object.entries(process.env)) {
        if (value === undefined || value === '') continue;
        if (!variable.startsWith(settings.prefix)) continue;
        const name = variable.slice(settings.prefix.length);
        if (!NAME.test(name)) continue;
        if (settings.prefix === '' && SYSTEM?.test(name)) continue;
        if (include && !include.test(name)) continue;
        names.push(name);
      }
      return Promise.resolve(names.sort().map((name) => ({ name })));
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
