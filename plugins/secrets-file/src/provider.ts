import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkHealth,
  SecretNotFoundError,
  SecretStoreError,
  withSettings,
  type Health,
  type HealthProbe,
  type PluginContext,
  type SecretListing,
  type SecretProvider,
  type SecretProviderType,
} from '@ai-switchboard/sdk';

import { settingsSchema, type FileSecretSettings } from './settings.js';

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

const NEW_FILE_MODE = 0o600;

/** Writes are refused for dotfiles too: temporary files and `..data` live there. */
function checkWritableName(name: string): void {
  if (!isSafeName(name) || name.startsWith('.')) {
    throw new SecretNotFoundError(`"${name}" is not a valid secret file name`);
  }
}

async function modeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

/**
 * Temp file in the same directory, then `rename`: a reader sees the old value or the new one,
 * never half of either. The file keeps the mode it had (0600 when new).
 */
async function writeAtomically(directory: string, name: string, value: string): Promise<void> {
  const path = join(directory, name);
  const mode = await modeOf(path);
  const tmp = join(directory, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, value, { encoding: 'utf8', mode, flag: 'wx' });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new SecretStoreError(
      `Secret file ${path} cannot be written (${codeOf(err) ?? 'error'})`,
      {
        cause: err,
      },
    );
  }
}

function writes(settings: FileSecretSettings): Pick<SecretProvider, 'set' | 'delete'> {
  if (settings.writable !== true) return {};
  return {
    async set(name: string, value: string): Promise<void> {
      checkWritableName(name);
      await writeAtomically(settings.directory, name, value);
    },
    async delete(name: string): Promise<void> {
      checkWritableName(name);
      const path = join(settings.directory, name);
      try {
        await rm(path, { force: true });
      } catch (err) {
        throw new SecretStoreError(
          `Secret file ${path} cannot be removed (${codeOf(err) ?? 'error'})`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

async function inspectDirectory(settings: FileSecretSettings): ReturnType<HealthProbe> {
  const dir = settings.directory;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { status: 'unhealthy', message: `${dir} is not a directory` };
    await access(dir, constants.R_OK | constants.X_OK);
  } catch (err) {
    return { status: 'unhealthy', message: `${dir} is not readable (${codeOf(err) ?? 'error'})` };
  }
  if (settings.writable === true) {
    try {
      await access(dir, constants.W_OK);
    } catch (err) {
      return {
        status: 'unhealthy',
        message: `${dir} is not writable (${codeOf(err) ?? 'error'}); turn writes off or fix the mount`,
      };
    }
  }
  return { status: 'healthy' };
}

function createFileProvider(settings: FileSecretSettings, ctx: PluginContext): SecretProvider {
  return {
    ...writes(settings),
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

    health: (): Promise<Health> => checkHealth(ctx, () => inspectDirectory(settings)),
  };
}

export const fileSecretProviderType: SecretProviderType = {
  id: 'file',
  displayName: 'Mounted files',
  icon: 'lock',
  description:
    'Reads each secret from a file in a directory, the Docker and Kubernetes secret pattern.',
  settingsSchema,
  create: withSettings(settingsSchema, 'file settings', createFileProvider),
};
