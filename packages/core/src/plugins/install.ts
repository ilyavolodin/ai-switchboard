import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SDK_VERSION } from '@ai-switchboard/sdk';

import { isRecord, str } from '../util/guards.js';

import { defaultImport, readDeclared, type ImportModule } from './declared.js';
import { withHomeLock } from './home-lock.js';
import { PluginInstallError, readJsonIfExists, writeJson } from './install-error.js';
import type { InspectResult } from './inspect.js';
import { readLockfile, writeLockfile, type PluginLockfile } from './lockfile.js';
import {
  checkSpec,
  defaultRunNpm,
  INSTALL_FLAGS,
  specPackageName,
  UNINSTALL_FLAGS,
  type RunNpm,
} from './npm.js';
import { isSdkCompatible, parseSwitchboardField } from './package-manifest.js';
import { pluginsDir } from './plugin-paths.js';

export type { DeclaredPlugin, ImportModule, PluginManifestSummary } from './declared.js';
export { inspectPlugin, type InspectOptions, type InspectResult } from './inspect.js';
export { isPluginInstallError, PluginInstallError } from './install-error.js';
export {
  listInstalled,
  type InstalledPlugin,
  type PluginLockEntry,
  type PluginLockfile,
} from './lockfile.js';
export { defaultRunNpm, specPackageName, type RunNpm } from './npm.js';
export { lockfilePath, pluginsDir } from './plugin-paths.js';

export interface InstallResult extends InspectResult {
  manifestPath: string;
}

export interface InstallOptions {
  home: string;
  spec: string;
  runNpm?: RunNpm;
  /** Read capabilities from `switchboard.source`, as the host does in dev (tsx). */
  allowSource?: boolean;
  importModule?: ImportModule;
  now?: () => Date;
  /** The caller already holds the home's lock (`withHomeLock`). */
  locked?: boolean;
}

export interface RemoveOptions {
  home: string;
  name: string;
  runNpm?: RunNpm;
  /** The caller already holds the home's lock (`withHomeLock`). */
  locked?: boolean;
}

function dependenciesOf(pkg: unknown): Record<string, string> {
  const deps = isRecord(pkg) ? pkg.dependencies : undefined;
  const out: Record<string, string> = {};
  if (isRecord(deps))
    for (const [k, v] of Object.entries(deps)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function readDependencies(dir: string): Promise<Record<string, string>> {
  return dependenciesOf(await readJsonIfExists(join(dir, 'package.json')));
}

async function ensurePluginsPackage(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'package.json');
  if ((await readJsonIfExists(path)) !== undefined) return;
  await writeJson(path, {
    name: 'switchboard-plugins',
    private: true,
    description: 'Plugins installed by `switchboard plugins add`. Managed file; do not edit.',
    dependencies: {},
  });
}

function installedName(
  spec: string,
  before: Record<string, string>,
  after: Record<string, string>,
  lock: PluginLockfile,
): string {
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
  if (changed.length === 1 && changed[0] !== undefined) return changed[0];
  const fromSpec = specPackageName(spec);
  if (fromSpec !== undefined && fromSpec in after) return fromSpec;
  // A reinstall of the same spec changes nothing in package.json: look it up by spec.
  const bySpec = Object.entries(lock.plugins).find(([n, e]) => e.spec === spec && n in after);
  if (bySpec) return bySpec[0];
  const byValue = Object.entries(after).find(([, v]) => v === spec);
  if (byValue) return byValue[0];
  throw new PluginInstallError(`could not tell which package "${spec}" installed`);
}

async function lockedIntegrity(dir: string, name: string): Promise<string | null> {
  const lock = await readJsonIfExists(join(dir, 'package-lock.json'));
  if (!isRecord(lock) || !isRecord(lock.packages)) return null;
  const entry = lock.packages[`node_modules/${name}`];
  return isRecord(entry) ? (str(entry.integrity) ?? null) : null;
}

/**
 * A package that turns out not to be a Switchboard plugin is removed again. Never loads the
 * plugin into the host: the host picks it up on its next start.
 */
export async function installPlugin(options: InstallOptions): Promise<InstallResult> {
  const spec = checkSpec(options.spec);
  if (options.locked) return install(options, spec);
  return withHomeLock(options.home, () => install(options, spec));
}

async function install(options: InstallOptions, spec: string): Promise<InstallResult> {
  const runNpm = options.runNpm ?? defaultRunNpm;
  const now = options.now ?? (() => new Date());
  const dir = pluginsDir(options.home);
  // Read the lockfile first: a corrupt one must stop us before npm changes anything.
  const lock = await readLockfile(options.home);
  await ensurePluginsPackage(dir);

  const before = await readDependencies(dir);
  await runNpm(['install', spec, ...INSTALL_FLAGS], dir);
  const after = await readDependencies(dir);
  const name = installedName(spec, before, after, lock);

  const packageDir = join(dir, 'node_modules', name);
  const manifestPath = join(packageDir, 'package.json');
  const pkg = await readJsonIfExists(manifestPath);
  const check = parseSwitchboardField(pkg);
  if (!isRecord(pkg) || !check.ok) {
    const reason = check.ok ? 'it has no package.json' : check.reason;
    const notPlugin = `${name} is not a Switchboard plugin: ${reason}.`;
    const pinned = lock.plugins[name];
    if (pinned === undefined) {
      await runNpm(['uninstall', name, ...UNINSTALL_FLAGS], dir);
      throw new PluginInstallError(`${notPlugin} It was removed again.`);
    }
    // An upgrade replaced a working plugin: put the pinned version back rather than leave the
    // lockfile naming a package that is gone.
    await runNpm(['install', `${name}@${pinned.version}`, ...INSTALL_FLAGS], dir);
    throw new PluginInstallError(`${notPlugin} The installed ${pinned.version} was restored.`);
  }

  const { field } = check;
  const version = str(pkg.version) ?? after[name] ?? '0.0.0';
  const integrity = await lockedIntegrity(dir, name);
  const warnings: string[] = [];
  const compatible = isSdkCompatible(field.sdk);
  if (!compatible) {
    warnings.push(
      `${name} declares SDK range "${field.sdk}", which the running SDK ${SDK_VERSION} does not satisfy; the host will mark it incompatible and not load it`,
    );
  }
  const declared = await readDeclared(
    packageDir,
    field,
    options.allowSource === true,
    options.importModule ?? defaultImport,
    warnings,
  );

  lock.plugins[name] = {
    version,
    integrity,
    sdk: field.sdk,
    installedAt: now().toISOString(),
    spec,
  };
  await writeLockfile(options.home, lock);

  return {
    name,
    version,
    integrity,
    sdkRange: field.sdk,
    compatible,
    ...declared,
    manifestPath,
    warnings,
  };
}

export async function removePlugin(options: RemoveOptions): Promise<void> {
  if (options.locked) return remove(options);
  return withHomeLock(options.home, () => remove(options));
}

async function remove(options: RemoveOptions): Promise<void> {
  const runNpm = options.runNpm ?? defaultRunNpm;
  const dir = pluginsDir(options.home);
  const lock = await readLockfile(options.home);
  const deps = await readDependencies(dir);
  if (!(options.name in lock.plugins) && !(options.name in deps)) {
    throw new PluginInstallError(`${options.name} is not installed in ${dir}`);
  }
  if (options.name in deps) {
    await runNpm(['uninstall', options.name, ...UNINSTALL_FLAGS], dir);
  }
  const plugins = Object.fromEntries(
    Object.entries(lock.plugins).filter(([name]) => name !== options.name),
  );
  await writeLockfile(options.home, { lockfileVersion: 1, plugins });
}
