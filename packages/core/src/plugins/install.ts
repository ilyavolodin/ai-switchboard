import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SDK_VERSION, type Capabilities, type PluginKind } from '@ai-switchboard/sdk';
import { isPluginDefinition } from '@ai-switchboard/sdk/host';

import { isRecord, str } from '../util/guards.js';

import { withHomeLock } from './home-lock.js';
import {
  isSdkCompatible,
  parseSwitchboardField,
  pluginEntry,
  type SwitchboardField,
} from './package-manifest.js';

export type RunNpm = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export type ImportModule = (url: string) => Promise<unknown>;

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

export interface PluginManifestSummary {
  pluginId: string;
  displayName: string;
  types: { kind: PluginKind; typeId: string; displayName: string }[];
}

export interface InstallResult {
  name: string;
  version: string;
  integrity: string | null;
  sdkRange: string;
  /** The host refuses to load an incompatible plugin. */
  compatible: boolean;
  /** Undefined when the entry could not be imported (see `warnings`). */
  capabilities: Capabilities | undefined;
  plugin: PluginManifestSummary | undefined;
  manifestPath: string;
  warnings: string[];
}

export interface InspectResult {
  name: string;
  version: string;
  sdkRange: string;
  compatible: boolean;
  integrity: string | null;
  capabilities: Capabilities | undefined;
  plugin: PluginManifestSummary | undefined;
  warnings: string[];
}

export interface InstalledPlugin extends PluginLockEntry {
  name: string;
}

export interface InstallOptions {
  home: string;
  spec: string;
  runNpm?: RunNpm;
  /** Fall back to `switchboard.source` when `switchboard.entry` is missing (dev with tsx). */
  allowSource?: boolean;
  importModule?: ImportModule;
  now?: () => Date;
  /** The caller already holds the home's lock (`withHomeLock`). */
  locked?: boolean;
}

export interface InspectOptions {
  spec: string;
  runNpm?: RunNpm;
  importModule?: ImportModule;
  tmpRoot?: string;
}

export interface RemoveOptions {
  home: string;
  name: string;
  runNpm?: RunNpm;
  /** The caller already holds the home's lock (`withHomeLock`). */
  locked?: boolean;
}

/** `message` is meant for the admin. */
export class PluginInstallError extends Error {
  override readonly name = 'PluginInstallError';
}

export function isPluginInstallError(err: unknown): err is PluginInstallError {
  return err instanceof Error && err.name === 'PluginInstallError';
}

/** `execFile`, not a shell, so specs are never interpreted. */
export const defaultRunNpm: RunNpm = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').slice(-6).join('\n');
          reject(new PluginInstallError(`npm ${args[0] ?? ''} failed: ${detail || error.message}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });

const defaultImport: ImportModule = (url) => import(url);

export function pluginsDir(home: string): string {
  return join(resolve(home), 'plugins');
}

export function lockfilePath(home: string): string {
  return join(resolve(home), 'plugins.lock.json');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return undefined;
    // A hand-edited or truncated file: say which one instead of a bare JSON parse error.
    if (err instanceof SyntaxError) {
      throw new PluginInstallError(`${path} is not valid JSON; fix or delete it`);
    }
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function dependenciesOf(pkg: unknown): Record<string, string> {
  const deps = isRecord(pkg) ? pkg.dependencies : undefined;
  const out: Record<string, string> = {};
  if (isRecord(deps))
    for (const [k, v] of Object.entries(deps)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** npm would read a spec starting with `-` as an option (`--registry=...`), not a package. */
function checkSpec(spec: string): string {
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

/**
 * `--install-links` copies a local directory instead of symlinking it, so the plugins directory
 * stays self-contained when it is baked into an image or backed up.
 */
const INSTALL_FLAGS = [
  '--save',
  '--install-links',
  '--ignore-scripts=false',
  '--no-audit',
  '--no-fund',
];
const UNINSTALL_FLAGS = ['--save', '--no-audit', '--no-fund'];

function summarise(plugin: unknown): {
  capabilities: Capabilities | undefined;
  plugin: PluginManifestSummary | undefined;
} {
  if (!isRecord(plugin)) return { capabilities: undefined, plugin: undefined };
  const caps = isRecord(plugin.capabilities) ? plugin.capabilities : {};
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const capabilities: Capabilities = {};
  const network = strings(caps.network);
  const secrets = strings(caps.secrets);
  if (network) capabilities.network = network;
  if (secrets) capabilities.secrets = secrets;
  if (!isPluginDefinition(plugin)) return { capabilities, plugin: undefined };

  const types: PluginManifestSummary['types'] = [];
  const add = (kind: PluginKind, list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const t of list as unknown[]) {
      if (isRecord(t) && typeof t.id === 'string') {
        types.push({ kind, typeId: t.id, displayName: str(t.displayName) ?? t.id });
      }
    }
  };
  add('source', plugin.sources);
  add('destination', plugin.destinations);
  add('notifier', plugin.notifiers);
  add('secret_provider', plugin.secretProviders);
  return {
    capabilities,
    plugin: { pluginId: plugin.id, displayName: plugin.displayName, types },
  };
}

/** Never throws. */
async function readDeclared(
  packageDir: string,
  field: SwitchboardField,
  allowSource: boolean,
  importModule: ImportModule,
  warnings: string[],
): Promise<ReturnType<typeof summarise>> {
  const rel = await pluginEntry(packageDir, field, allowSource);
  try {
    const mod = await importModule(pathToFileURL(join(packageDir, rel)).href);
    const declared = isRecord(mod) ? mod.default : undefined;
    if (!isRecord(declared)) {
      warnings.push(`${rel} has no default export; capabilities could not be read`);
      return { capabilities: undefined, plugin: undefined };
    }
    return summarise(declared);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    warnings.push(`could not import ${rel} to read capabilities: ${message ?? ''}`);
    return { capabilities: undefined, plugin: undefined };
  }
}

async function readLockfile(home: string): Promise<PluginLockfile> {
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

async function writeLockfile(home: string, lock: PluginLockfile): Promise<void> {
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

  const before = dependenciesOf(await readJsonIfExists(join(dir, 'package.json')));
  await runNpm(
    // --install-links copies a local directory instead of symlinking it, so the plugins
    // directory stays self-contained when it is baked into an image or backed up.
    ['install', spec, ...INSTALL_FLAGS],
    dir,
  );
  const after = dependenciesOf(await readJsonIfExists(join(dir, 'package.json')));
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
    capabilities: declared.capabilities,
    plugin: declared.plugin,
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
  const deps = dependenciesOf(await readJsonIfExists(join(dir, 'package.json')));
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

interface PackEntry {
  filename: string;
  integrity: string | null;
}

function parsePackOutput(stdout: string): PackEntry {
  // npm may print lifecycle output before the JSON array.
  const start = stdout.indexOf('[');
  let parsed: unknown;
  try {
    parsed = JSON.parse(start === -1 ? stdout : stdout.slice(start));
  } catch {
    throw new PluginInstallError('npm pack did not print JSON');
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const filename = isRecord(first) ? str(first.filename) : undefined;
  if (!isRecord(first) || filename === undefined) {
    throw new PluginInstallError('npm pack did not report a tarball');
  }
  return { filename, integrity: str(first.integrity) ?? null };
}

const untar = (file: string, cwd: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile('tar', ['-xzf', file], { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new PluginInstallError(`tar failed: ${stderr.trim() || error.message}`));
      else resolvePromise();
    });
  });

/** Linked beside a packed plugin so it can import the running SDK. */
async function sdkPackageRoot(): Promise<string | undefined> {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve('@ai-switchboard/sdk')));
    for (let i = 0; i < 6; i++) {
      const pkg = await readJsonIfExists(join(dir, 'package.json'));
      if (isRecord(pkg) && pkg.name === '@ai-switchboard/sdk') return dir;
      dir = dirname(dir);
    }
  } catch {
    // Not resolvable here; the import below then fails and is reported as a warning.
  }
  return undefined;
}

async function linkSdk(tmp: string): Promise<void> {
  const root = await sdkPackageRoot();
  if (root === undefined) return;
  const target = join(tmp, 'node_modules', '@ai-switchboard', 'sdk');
  await mkdir(dirname(target), { recursive: true });
  try {
    await lstat(target);
  } catch {
    await symlink(root, target, 'dir');
  }
}

/**
 * Reads the manifest from `npm pack` without installing. Capabilities come from importing a
 * plain-JS entry with only the SDK linked, so a plugin with other runtime dependencies reports
 * them as unknown.
 */
export async function inspectPlugin(options: InspectOptions): Promise<InspectResult> {
  const runNpm = options.runNpm ?? defaultRunNpm;
  const spec = checkSpec(options.spec);
  const tmp = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'switchboard-inspect-'));
  try {
    const { stdout } = await runNpm(['pack', spec, '--json', '--pack-destination', tmp], tmp);
    const packed = parsePackOutput(stdout);
    await untar(join(tmp, packed.filename), tmp);
    const packageDir = join(tmp, 'package');
    const pkg = await readJsonIfExists(join(packageDir, 'package.json'));
    if (!isRecord(pkg)) throw new PluginInstallError(`${spec}: the tarball has no package.json`);
    const name = str(pkg.name) ?? spec;
    const check = parseSwitchboardField(pkg);
    if (!check.ok)
      throw new PluginInstallError(`${name} is not a Switchboard plugin: ${check.reason}`);
    const { field } = check;
    const warnings: string[] = [];
    let declared: ReturnType<typeof summarise> = { capabilities: undefined, plugin: undefined };
    if (/\.(m?js)$/.test(field.entry)) {
      await linkSdk(tmp);
      declared = await readDeclared(
        packageDir,
        field,
        false,
        options.importModule ?? defaultImport,
        warnings,
      );
    } else {
      warnings.push('the entry is not plain JavaScript; capabilities are shown after install');
    }
    return {
      name,
      version: str(pkg.version) ?? '0.0.0',
      sdkRange: field.sdk,
      compatible: isSdkCompatible(field.sdk),
      integrity: packed.integrity,
      capabilities: declared.capabilities,
      plugin: declared.plugin,
      warnings,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
