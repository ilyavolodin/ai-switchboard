import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { InstanceKind } from '../domain/status.js';
import type { CoreLogger } from '../logger.js';

import { REMOVED_MESSAGE, type PluginCatalog } from './catalog-store.js';
import { discoverPlugins } from './discovery.js';
import { PluginInstallError } from './install-error.js';
import {
  defaultScanDirs,
  PluginLoader,
  type BuiltinPlugin,
  type EvaluatedPlugin,
  type LoadedPlugin,
  type ScanDir,
} from './loader.js';
import { installedModulesDir } from './plugin-paths.js';
import type { TypeRegistry } from './type-registry.js';

export interface HotLoadResult {
  plugin: LoadedPlugin;
  /** Another version is loaded (the ES module cache keeps its code); a restart applies it. */
  pendingRestart: boolean;
}

export interface PluginSetDeps {
  config: Pick<CoreConfig, 'home' | 'pluginDirs' | 'devSource'>;
  clock: Clock;
  logger: CoreLogger;
  registry: TypeRegistry;
  catalog: PluginCatalog;
  /** Rebuilds the instances of types that came or went. */
  rebuildTypes(types: readonly { kind: InstanceKind; typeId: string }[]): Promise<void>;
  builtin?: readonly BuiltinPlugin[];
  scanDirs?: readonly ScanDir[];
}

/**
 * The plugin packages this process evaluated and their lifecycle: load at boot, hot-load after an
 * install, unregister after a removal. Owns the loader, the registry writes and the catalog rows
 * that describe packages. Records are replaced, never changed in place.
 */
export class PluginSet {
  private plugins: readonly LoadedPlugin[] = [];
  private readonly loader: PluginLoader;

  constructor(private readonly deps: PluginSetDeps) {
    this.loader = new PluginLoader({
      config: deps.config,
      registry: deps.registry,
      logger: deps.logger,
    });
  }

  /** In discovery order. */
  get loaded(): readonly LoadedPlugin[] {
    return this.plugins;
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  /** The plugin's declared network capability. */
  networkOf(name: string): string[] | undefined {
    return this.get(name)?.definition?.capabilities.network;
  }

  async loadAll(): Promise<void> {
    const { config, builtin = [], scanDirs, catalog, registry, clock } = this.deps;
    const discovered = await discoverPlugins([...(scanDirs ?? defaultScanDirs(config))]);
    const evaluated: { plugin: EvaluatedPlugin; sdkRange: string }[] = [];
    for (const candidate of this.loader.candidates(builtin, discovered))
      evaluated.push({
        plugin: await this.loader.evaluate(candidate),
        sdkRange: candidate.pkg.sdk,
      });
    this.plugins = evaluated.map((e) => e.plugin);
    await catalog.replaceLoaded(evaluated, registry.list(), clock.now());
  }

  /** Without a restart; a package whose other version is loaded waits for the next start. */
  async hotLoad(name: string): Promise<HotLoadResult> {
    const { config, catalog, registry, clock, logger } = this.deps;
    const dir = installedModulesDir(config.home);
    const pkg = (await discoverPlugins([{ path: dir, origin: 'installed' }])).find(
      (p) => p.name === name,
    );
    if (!pkg) throw new PluginInstallError(`${name} is not installed in ${dir}`);

    const existing = this.get(name);
    if (existing?.status === 'loaded') {
      return { plugin: existing, pendingRestart: existing.version !== pkg.version };
    }
    const record = await this.loader.evaluate(
      this.loader.candidate({ ...pkg, origin: 'installed' }, existing !== undefined),
    );
    this.put(record);

    const types = registry.list(name);
    await catalog.upsertLoaded(record, pkg.switchboard.sdk, types, clock.now());
    if (record.status === 'loaded') {
      logger.info({ plugin: name, version: record.version }, 'plugin hot-loaded');
      await this.deps.rebuildTypes(types);
    }
    return { plugin: record, pendingRestart: false };
  }

  /**
   * Idempotent. Instances that used its types rebuild and report `plugin_unavailable`. The ES
   * module cache keeps its code; a later re-install imports a fresh copy.
   */
  async unregister(name: string): Promise<void> {
    const { registry, catalog, clock, logger } = this.deps;
    const record = this.get(name);
    const dropped = registry.unregister(name);
    if (record && record.status !== 'removed') {
      const { definition: _definition, ...rest } = record;
      this.put({ ...rest, status: 'removed', message: REMOVED_MESSAGE });
      logger.info({ plugin: name }, 'plugin removed; types unregistered');
    }
    if (dropped.length > 0) await this.deps.rebuildTypes(dropped);
    await catalog.markRemoved(name, clock.now());
  }

  private put(record: LoadedPlugin): void {
    const index = this.plugins.findIndex((p) => p.name === record.name);
    this.plugins =
      index === -1
        ? [...this.plugins, record]
        : this.plugins.map((p, i) => (i === index ? record : p));
  }
}
