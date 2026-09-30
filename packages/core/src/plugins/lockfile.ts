import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isRecord, str } from '../util/guards.js';

import { readJsonIfExists, writeJson } from './install-error.js';
import { lockfilePath } from './plugin-paths.js';

export interface PluginLockEntry {
  version: string;
  /** Null for local directory installs, which have none. */
  integrity: string | null;
  sdk: string;
  installedAt: string;
  spec: string;
}

export interface PluginLockfile {
  lockfileVersion: 1;
  plugins: Record<string, PluginLockEntry>;
}

export interface InstalledPlugin extends PluginLockEntry {
  name: string;
}

export async function readLockfile(home: string): Promise<PluginLockfile> {
  const raw = await readJsonIfExists(lockfilePath(home));
  const plugins: Record<string, PluginLockEntry> = {};
  if (isRecord(raw) && isRecord(raw.plugins)) {
    for (const [name, e] of Object.entries(raw.plugins)) {
      if (!isRecord(e) || typeof e.version !== 'string') continue;
      plugins[name] = {
        version: e.version,
        integrity: str(e.integrity) ?? null,
        sdk: str(e.sdk) ?? '*',
        installedAt: str(e.installedAt) ?? '',
        spec: str(e.spec) ?? name,
      };
    }
  }
  return { lockfileVersion: 1, plugins };
}

export async function writeLockfile(home: string, lock: PluginLockfile): Promise<void> {
  const sorted: Record<string, PluginLockEntry> = {};
  for (const name of Object.keys(lock.plugins).sort()) {
    const entry = lock.plugins[name];
    if (entry) sorted[name] = entry;
  }
  await mkdir(resolve(home), { recursive: true });
  await writeJson(lockfilePath(home), { lockfileVersion: 1, plugins: sorted });
}

export async function listInstalled(home: string): Promise<InstalledPlugin[]> {
  const lock = await readLockfile(home);
  return Object.entries(lock.plugins)
    .map(([name, e]) => ({ name, ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
