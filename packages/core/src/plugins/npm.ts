import { execFile } from 'node:child_process';

import { PluginInstallError } from './install-error.js';

export type RunNpm = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

/** `execFile`, not a shell, so arguments are never interpreted. Fails with the tail of stderr. */
function run(
  command: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').slice(-6).join('\n');
          reject(new PluginInstallError(`${label} failed: ${detail || error.message}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

export const defaultRunNpm: RunNpm = (args, cwd) =>
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, `npm ${args[0] ?? ''}`);

export async function untar(file: string, cwd: string): Promise<void> {
  await run('tar', ['-xzf', file], cwd, 'tar');
}

/**
 * `--install-links` copies a local directory instead of symlinking it, so the plugins directory
 * stays self-contained when it is baked into an image or backed up.
 */
export const INSTALL_FLAGS = [
  '--save',
  '--install-links',
  '--ignore-scripts=false',
  '--no-audit',
  '--no-fund',
];
export const UNINSTALL_FLAGS = ['--save', '--no-audit', '--no-fund'];

/** npm would read a spec starting with `-` as an option (`--registry=...`), not a package. */
export function checkSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === '') throw new PluginInstallError('a package spec is required');
  if (trimmed.startsWith('-')) throw new PluginInstallError(`"${trimmed}" is not a package spec`);
  return trimmed;
}

export function specPackageName(spec: string): string | undefined {
  const trimmed = spec.trim();
  if (/^(\.|\/|~|file:|git\+|git:|https?:|github:)/.test(trimmed)) return undefined;
  if (trimmed.startsWith('@')) {
    const at = trimmed.indexOf('@', 1);
    return at === -1 ? trimmed : trimmed.slice(0, at);
  }
  const at = trimmed.indexOf('@');
  const name = at === -1 ? trimmed : trimmed.slice(0, at);
  return name.includes('/') ? undefined : name;
}
