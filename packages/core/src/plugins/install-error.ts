import { readFile, writeFile } from 'node:fs/promises';

import { isRecord } from '../util/guards.js';

/** `message` is meant for the admin. */
export class PluginInstallError extends Error {
  override readonly name = 'PluginInstallError';
}

export function isPluginInstallError(err: unknown): err is PluginInstallError {
  return err instanceof Error && err.name === 'PluginInstallError';
}

/** Undefined when the file does not exist; a file that is not JSON is named in the error. */
export async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return undefined;
    if (err instanceof SyntaxError) {
      throw new PluginInstallError(`${path} is not valid JSON; fix or delete it`);
    }
    throw err;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
