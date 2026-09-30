import {
  checkHealth,
  SecretNotFoundError,
  withSettings,
  type Health,
  type PluginContext,
  type SecretListing,
  type SecretProvider,
  type SecretProviderType,
} from '@ai-switchboard/sdk';

import { settingsSchema, type EnvSecretSettings } from './settings.js';

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
    health: (): Promise<Health> => checkHealth(ctx, () => Promise.resolve({ status: 'healthy' })),
  };
}

export const envSecretProviderType: SecretProviderType = {
  id: 'env',
  displayName: 'Environment variables',
  icon: 'key',
  description: 'Reads secrets from environment variables of the Switchboard process.',
  settingsSchema,
  create: withSettings(settingsSchema, 'env settings', createEnvProvider),
};
