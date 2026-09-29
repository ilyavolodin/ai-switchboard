import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseWith,
  type Health,
  type JSONSchema,
  type PluginContext,
  type SecretListing,
  type SecretProvider,
  type SecretProviderType,
  type Settings,
} from '@ai-switchboard/sdk';

export interface FileSecretSettings {
  /** One file per secret: `secret://file/github-token` reads `<directory>/github-token`. */
  directory: string;
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
  },
};

/** Also thrown when the file cannot be read. The message never carries a value. */
export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';
}

/** A bare file name: no separators, no `..`, no NUL, no leading dot-dot tricks. */
export function isSafeName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes('\0')
  );
}

function codeOf(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

function createFileProvider(settings: FileSecretSettings, ctx: PluginContext): SecretProvider {
  return {
    async resolve(name: string): Promise<string> {
      if (!isSafeName(name)) {
        throw new SecretNotFoundError(`"${name}" is not a valid secret file name`);
      }
      const path = join(settings.directory, name);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch (err) {
        const code = codeOf(err);
        throw new SecretNotFoundError(
          code === 'ENOENT'
            ? `Secret file ${path} does not exist`
            : `Secret file ${path} cannot be read (${code ?? 'error'})`,
        );
      }
      // Files written by `echo` or editors end in a newline that is not part of the secret.
      const value = content.replace(/(\r?\n)+$/, '');
      if (value === '') throw new SecretNotFoundError(`Secret file ${path} is empty`);
      return value;
    },

    /**
     * Follows symlinks (Kubernetes mounts each key as a symlink into `..data/`) and skips dotfiles,
     * including `..data`. File contents are never read.
     */
    async list(): Promise<SecretListing[]> {
      let entries: string[];
      try {
        entries = await readdir(settings.directory);
      } catch (err) {
        throw new SecretNotFoundError(
          `${settings.directory} cannot be listed (${codeOf(err) ?? 'error'})`,
        );
      }
      const out: SecretListing[] = [];
      for (const name of entries.sort()) {
        if (name.startsWith('.') || !isSafeName(name)) continue;
        try {
          const info = await stat(join(settings.directory, name));
          if (!info.isFile() || info.size === 0) continue;
          out.push({ name, updatedAt: info.mtime.toISOString() });
        } catch {
          // A dangling symlink or a file removed mid-listing: not available, so not listed.
        }
      }
      return out;
    },

    async health(): Promise<Health> {
      const checkedAt = (): string => ctx.now().toISOString();
      try {
        const info = await stat(settings.directory);
        if (!info.isDirectory()) {
          return {
            status: 'unhealthy',
            message: `${settings.directory} is not a directory`,
            checkedAt: checkedAt(),
          };
        }
        await access(settings.directory, constants.R_OK | constants.X_OK);
        return { status: 'healthy', checkedAt: checkedAt() };
      } catch (err) {
        return {
          status: 'unhealthy',
          message: `${settings.directory} is not readable (${codeOf(err) ?? 'error'})`,
          checkedAt: checkedAt(),
        };
      }
    },
  };
}

export const fileSecretProviderType: SecretProviderType = {
  id: 'file',
  displayName: 'Mounted files',
  icon: 'lock',
  description:
    'Reads each secret from a file in a directory, the Docker and Kubernetes secret pattern.',
  settingsSchema,
  create: (settings: Settings, ctx: PluginContext) =>
    createFileProvider(
      parseWith<FileSecretSettings>(settingsSchema, settings, 'file settings'),
      ctx,
    ),
};
