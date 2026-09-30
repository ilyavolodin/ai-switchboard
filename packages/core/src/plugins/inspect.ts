import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, str } from '../util/guards.js';

import { defaultImport, readDeclared, type DeclaredPlugin, type ImportModule } from './declared.js';
import { PluginInstallError, readJsonIfExists } from './install-error.js';
import { checkSpec, defaultRunNpm, untar, type RunNpm } from './npm.js';
import { isSdkCompatible, parseSwitchboardField } from './package-manifest.js';

export interface InspectResult extends DeclaredPlugin {
  name: string;
  version: string;
  sdkRange: string;
  /** The host refuses to load an incompatible plugin. */
  compatible: boolean;
  integrity: string | null;
  warnings: string[];
}

export interface InspectOptions {
  spec: string;
  runNpm?: RunNpm;
  importModule?: ImportModule;
  tmpRoot?: string;
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
    let declared: DeclaredPlugin = { capabilities: undefined, plugin: undefined };
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
      ...declared,
      warnings,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
