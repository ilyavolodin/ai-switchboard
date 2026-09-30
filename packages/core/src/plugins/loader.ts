import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SDK_MAJOR, SDK_VERSION, type PluginDefinition } from '@ai-switchboard/sdk';
import { isPluginDefinition, validatePlugin } from '@ai-switchboard/sdk/host';

import type { CoreConfig } from '../config.js';
import type { PluginOrigin, PluginStatus } from '../domain/status.js';
import type { CoreLogger } from '../logger.js';
import { errorText } from '../util/errors.js';

import type { DiscoveredPackage } from './discovery.js';
import { isSdkCompatible, pluginEntry } from './package-manifest.js';
import type { TypeRegistry } from './type-registry.js';

export interface LoadedPlugin {
  name: string;
  version: string;
  origin: PluginOrigin;
  /** `removed`: an admin removed it while this process ran; its types are unregistered. */
  status: Exclude<PluginStatus, 'unavailable'> | 'removed';
  message?: string;
  definition?: PluginDefinition;
}

export type EvaluatedPlugin = LoadedPlugin & {
  status: Exclude<LoadedPlugin['status'], 'removed'>;
};

export interface BuiltinPlugin {
  name: string;
  version: string;
  definition: PluginDefinition;
}

export interface ScanDir {
  path: string;
  origin: PluginOrigin;
}

export interface Candidate {
  pkg: Pick<DiscoveredPackage, 'name' | 'version' | 'origin'> & { sdk: string };
  load: () => Promise<unknown>;
}

export type DefinitionCheck =
  | { status: 'loaded'; definition: PluginDefinition }
  | { status: 'failed' | 'incompatible'; message: string };

/** Refuses a range the running SDK does not satisfy before anything is imported. */
export function checkSdkRange(range: string): string | undefined {
  return isSdkCompatible(range)
    ? undefined
    : `declares sdk ${range}; running SDK is ${SDK_VERSION}`;
}

/** What the host makes of a package's default export. */
export function checkDefinition(
  def: unknown,
  clash: (def: PluginDefinition) => string | undefined,
): DefinitionCheck {
  if (!isPluginDefinition(def))
    return { status: 'failed', message: 'default export is not a definePlugin() result' };
  if (def.switchboardSdk.major !== SDK_MAJOR)
    return {
      status: 'incompatible',
      message: `built against SDK major ${def.switchboardSdk.major}`,
    };
  const problems = validatePlugin(def);
  if (problems.length > 0) return { status: 'failed', message: problems.slice(0, 5).join('; ') };
  const clashing = clash(def);
  if (clashing) return { status: 'failed', message: clashing };
  return { status: 'loaded', definition: def };
}

export function defaultScanDirs(config: Pick<CoreConfig, 'home' | 'pluginDirs'>): ScanDir[] {
  const coreNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
  return [
    { path: join(config.home, 'plugins', 'node_modules'), origin: 'installed' },
    ...config.pluginDirs.map((path) => ({ path, origin: 'installed' as const })),
    { path: coreNodeModules, origin: 'baked' },
    { path: join(process.cwd(), 'node_modules'), origin: 'baked' },
  ];
}

/** Imports and checks packages, and registers the types of the ones that load. */
export class PluginLoader {
  private importGeneration = 0;

  constructor(
    private readonly deps: {
      config: Pick<CoreConfig, 'devSource'>;
      registry: TypeRegistry;
      logger: CoreLogger;
    },
  ) {}

  candidates(
    builtin: readonly BuiltinPlugin[],
    discovered: readonly DiscoveredPackage[],
  ): Candidate[] {
    return [
      ...builtin.map((b) => ({
        pkg: {
          name: b.name,
          version: b.version,
          origin: 'baked' as const,
          sdk: `^${SDK_MAJOR}.0.0`,
        },
        load: () => Promise.resolve(b.definition as unknown),
      })),
      ...discovered.map((pkg) => this.candidate(pkg)),
    ];
  }

  /** `fresh`: import a new copy, since a failed earlier import stays in the ES module cache. */
  candidate(pkg: DiscoveredPackage, fresh = false): Candidate {
    const bust = fresh ? `?v=${encodeURIComponent(pkg.version)}.${++this.importGeneration}` : '';
    return {
      pkg: { name: pkg.name, version: pkg.version, origin: pkg.origin, sdk: pkg.switchboard.sdk },
      load: () => this.importDefinition(pkg, bust),
    };
  }

  async evaluate({ pkg, load }: Candidate): Promise<EvaluatedPlugin> {
    const record: EvaluatedPlugin = {
      name: pkg.name,
      version: pkg.version,
      origin: pkg.origin,
      status: 'loaded',
    };
    try {
      const refused = checkSdkRange(pkg.sdk);
      const check: DefinitionCheck = refused
        ? { status: 'incompatible', message: refused }
        : checkDefinition(await load(), (def) => this.deps.registry.findClash(def));
      if (check.status === 'loaded') {
        record.definition = check.definition;
        this.deps.registry.register(pkg.name, check.definition);
      } else {
        record.status = check.status;
        record.message = check.message;
      }
    } catch (err) {
      record.status = 'failed';
      record.message = errorText(err);
    }
    if (record.status !== 'loaded')
      this.deps.logger.warn(
        { plugin: pkg.name, status: record.status, reason: record.message },
        'plugin not loaded',
      );
    return record;
  }

  private async importDefinition(pkg: DiscoveredPackage, query: string): Promise<unknown> {
    const file = join(
      pkg.dir,
      await pluginEntry(pkg.dir, pkg.switchboard, this.deps.config.devSource),
    );
    const mod = (await import(`${pathToFileURL(file).href}${query}`)) as { default?: unknown };
    return mod.default;
  }
}
