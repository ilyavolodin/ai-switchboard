import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import semver from 'semver';

import {
  SDK_VERSION,
  isPluginDefinition,
  type Capabilities,
  type PluginKind,
} from '@ai-switchboard/sdk';

/**
 * Installing, inspecting and removing plugin packages in `$SWITCHBOARD_HOME/plugins`.
 *
 * Shared by the `switchboard plugins` CLI and the core's Plugins API. Everything that touches
 * npm goes through an injected `RunNpm` so tests never reach a registry. Installing never
 * loads the plugin into the host: the host picks it up on its next start.
 */

/** Runs `npm <args>` in `cwd` and resolves with its output, or rejects when npm exits non-zero. */
export type RunNpm = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

/** Loads an ES module by file URL. Injected so tests can control plugin imports. */
export type ImportModule = (url: string) => Promise<unknown>;

/** One entry of `$SWITCHBOARD_HOME/plugins.lock.json`. */
export interface PluginLockEntry {
  version: string;
  /** npm's SRI hash (`sha512-...`); null for local directory installs that have none. */
  integrity: string | null;
  /** The SDK range the package declares in its `switchboard.sdk` field. */
  sdk: string;
  installedAt: string;
  /** What the admin asked for, e.g. `@acme/switchboard-source-jira@^1`. */
  spec: string;
}

export interface PluginLockfile {
  lockfileVersion: 1;
  plugins: Record<string, PluginLockEntry>;
}

/** What a plugin's default export declares, read by importing its entry. */
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
  /** Whether the running SDK satisfies the declared range; the host refuses to load it otherwise. */
  compatible: boolean;
  /** Undefined when the entry could not be imported (see `warnings`). */
  capabilities: Capabilities | undefined;
  plugin: PluginManifestSummary | undefined;
  /** The installed package's `package.json`. */
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
  /** `$SWITCHBOARD_HOME`. */
  home: string;
  /** Any npm install spec: `name`, `name@range`, a tarball URL, a git URL, a local path. */
  spec: string;
  runNpm?: RunNpm;
  /** Fall back to `switchboard.source` when `switchboard.entry` is missing (dev with tsx). */
  allowSource?: boolean;
  importModule?: ImportModule;
  now?: () => Date;
}

export interface InspectOptions {
  spec: string;
  runNpm?: RunNpm;
  importModule?: ImportModule;
  /** Where the temporary pack directory is created (defaults to the OS temp dir). */
  tmpRoot?: string;
}

export interface RemoveOptions {
  home: string;
  name: string;
  runNpm?: RunNpm;
}

/** Install, inspect or remove failed; `message` is meant for the admin. */
export class PluginInstallError extends Error {
  override readonly name = 'PluginInstallError';
}

export function isPluginInstallError(err: unknown): err is PluginInstallError {
  return err instanceof Error && err.name === 'PluginInstallError';
}

/** The real npm, through `execFile` (no shell, so specs are never interpreted). */
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

// ---------------------------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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

/**
 * npm commands in one plugins directory run one at a time: concurrent installs (an API request
 * and a replica catching up) would race on `package.json`, `node_modules` and the lockfile.
 */
const homeQueues = new Map<string, Promise<unknown>>();

function serialized<T>(home: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(home);
  const previous = homeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  homeQueues.set(key, settled);
  void settled.then(() => {
    if (homeQueues.get(key) === settled) homeQueues.delete(key);
  });
  return next;
}

/** The package name in a registry spec (`@scope/name@^1` → `@scope/name`), if it has one. */
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

// ---------------------------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------------------------

interface SwitchboardField {
  entry: string | undefined;
  source: string | undefined;
  sdk: string;
}

function switchboardField(pkg: unknown): SwitchboardField | undefined {
  if (!isRecord(pkg) || !isRecord(pkg.switchboard)) return undefined;
  const f = pkg.switchboard;
  return { entry: str(f.entry), source: str(f.source), sdk: str(f.sdk) ?? '*' };
}

function isCompatible(range: string): boolean {
  return semver.validRange(range) !== null && semver.satisfies(SDK_VERSION, range);
}

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

/** Import the plugin entry and read what its default export declares. Never throws. */
async function readDeclared(
  packageDir: string,
  field: SwitchboardField,
  allowSource: boolean,
  importModule: ImportModule,
  warnings: string[],
): Promise<ReturnType<typeof summarise>> {
  const rel = field.entry ?? (allowSource ? field.source : undefined);
  if (rel === undefined) {
    warnings.push('the package declares no switchboard.entry; capabilities could not be read');
    return { capabilities: undefined, plugin: undefined };
  }
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

// ---------------------------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------------------------

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

/** Installed plugins, from `plugins.lock.json`, sorted by name. */
export async function listInstalled(home: string): Promise<InstalledPlugin[]> {
  const lock = await readLockfile(home);
  return Object.entries(lock.plugins)
    .map(([name, e]) => ({ name, ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

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

/** Which dependency the install added or changed; falls back to the spec's own name. */
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
 * `npm install <spec>` into `$home/plugins`, check it is a Switchboard plugin (removing it again
 * if not), and pin its exact version and integrity in `$home/plugins.lock.json`.
 */
export async function installPlugin(options: InstallOptions): Promise<InstallResult> {
  const spec = checkSpec(options.spec);
  return serialized(options.home, () => install(options, spec));
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
    [
      'install',
      spec,
      '--save',
      '--install-links',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
    ],
    dir,
  );
  const after = dependenciesOf(await readJsonIfExists(join(dir, 'package.json')));
  const name = installedName(spec, before, after, lock);

  const packageDir = join(dir, 'node_modules', name);
  const manifestPath = join(packageDir, 'package.json');
  const pkg = await readJsonIfExists(manifestPath);
  const field = switchboardField(pkg);
  if (!isRecord(pkg) || field === undefined) {
    const notPlugin = `${name} is not a Switchboard plugin: its package.json has no "switchboard" field.`;
    const pinned = lock.plugins[name];
    if (pinned === undefined) {
      await runNpm(['uninstall', name, '--save', '--no-audit', '--no-fund'], dir);
      throw new PluginInstallError(`${notPlugin} It was removed again.`);
    }
    // An upgrade replaced a working plugin: put the pinned version back rather than leave the
    // lockfile naming a package that is gone.
    await runNpm(
      [
        'install',
        `${name}@${pinned.version}`,
        '--save',
        '--install-links',
        '--ignore-scripts=false',
        '--no-audit',
        '--no-fund',
      ],
      dir,
    );
    throw new PluginInstallError(`${notPlugin} The installed ${pinned.version} was restored.`);
  }

  const version = str(pkg.version) ?? after[name] ?? '0.0.0';
  const integrity = await lockedIntegrity(dir, name);
  const warnings: string[] = [];
  const compatible = isCompatible(field.sdk);
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

// ---------------------------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------------------------

/** `npm uninstall <name>` from `$home/plugins` and drop it from the lockfile. */
export async function removePlugin(options: RemoveOptions): Promise<void> {
  return serialized(options.home, () => remove(options));
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
    await runNpm(['uninstall', options.name, '--save', '--no-audit', '--no-fund'], dir);
  }
  const plugins = Object.fromEntries(
    Object.entries(lock.plugins).filter(([name]) => name !== options.name),
  );
  await writeLockfile(options.home, { lockfileVersion: 1, plugins });
}

// ---------------------------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------------------------

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

/** Directory holding the running SDK's package.json, so a packed plugin can import it. */
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
 * `npm pack <spec>` into a temporary directory and read the manifest without installing. The
 * capabilities are read by importing a plain-JS entry with the running SDK linked beside it; a
 * plugin with other runtime dependencies reports them as unknown.
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
    const field = switchboardField(pkg);
    if (field === undefined) {
      throw new PluginInstallError(
        `${name} is not a Switchboard plugin: its package.json has no "switchboard" field`,
      );
    }
    const warnings: string[] = [];
    let declared: ReturnType<typeof summarise> = { capabilities: undefined, plugin: undefined };
    if (field.entry !== undefined && /\.(m?js)$/.test(field.entry)) {
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
      compatible: isCompatible(field.sdk),
      integrity: packed.integrity,
      capabilities: declared.capabilities,
      plugin: declared.plugin,
      warnings,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
