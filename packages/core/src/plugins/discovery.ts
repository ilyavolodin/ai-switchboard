import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginOrigin } from '../domain/status.js';

export interface SwitchboardField {
  entry: string;
  source?: string;
  sdk: string;
}

export interface DiscoveredPackage {
  name: string;
  version: string;
  dir: string;
  switchboard: SwitchboardField;
  origin: PluginOrigin;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readPackage(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function switchboardField(pkg: Record<string, unknown>): SwitchboardField | null {
  const field = pkg.switchboard;
  if (field === null || typeof field !== 'object') return null;
  const f = field as Record<string, unknown>;
  if (typeof f.entry !== 'string' || typeof f.sdk !== 'string') return null;
  return {
    entry: f.entry,
    sdk: f.sdk,
    ...(typeof f.source === 'string' ? { source: f.source } : {}),
  };
}

async function packageDirs(nodeModules: string): Promise<string[]> {
  if (!(await isDir(nodeModules))) return [];
  const out: string[] = [];
  for (const entry of await readdir(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const full = join(nodeModules, entry);
    if (entry.startsWith('@')) {
      if (!(await isDir(full))) continue;
      for (const inner of await readdir(full)) out.push(join(full, inner));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * The first occurrence of a package name wins: installed dirs are scanned first, so an
 * admin-installed version overrides a baked one.
 */
export async function discoverPlugins(
  dirs: { path: string; origin: PluginOrigin }[],
): Promise<DiscoveredPackage[]> {
  const found = new Map<string, DiscoveredPackage>();
  const seenReal = new Set<string>();
  for (const { path, origin } of dirs) {
    for (const dir of await packageDirs(path)) {
      let real: string;
      try {
        real = await realpath(dir);
      } catch {
        continue;
      }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      const pkg = await readPackage(real);
      if (!pkg || typeof pkg.name !== 'string') continue;
      const field = switchboardField(pkg);
      if (!field || found.has(pkg.name)) continue;
      found.set(pkg.name, {
        name: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
        dir: real,
        switchboard: field,
        origin,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
