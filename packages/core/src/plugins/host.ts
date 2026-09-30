import { join } from 'node:path';

import { isWritableSecretProvider, type Settings } from '@ai-switchboard/sdk';

import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { InstanceError } from '../domain/instance-error.js';
import type { InstanceKind } from '../domain/status.js';
import type { CoreLogger } from '../logger.js';
import { parseSecretRef, resolveSecretRefs } from '../secrets/refs.js';
import type { Telemetry } from '../telemetry/telemetry.js';
import { errorText } from '../util/errors.js';
import { exists } from '../util/fs.js';

import type { PluginAdminPort, PreviewSourceResult } from './admin-port.js';
import {
  createPluginCatalog,
  readOnlyPluginCatalog,
  REMOVED_MESSAGE,
  type PluginCatalog,
} from './catalog-store.js';
import { discoverPlugins } from './discovery.js';
import { PluginErrorCounter, type PluginErrorKind } from './error-counter.js';
import { checkAllHealth } from './health.js';
import { pluginsDir, PluginInstallError, type InstallResult, type RunNpm } from './install.js';
import { InstallSync, type HotLoadResult } from './install-sync.js';
import { instanceSecretPrefix } from './instance-secrets.js';
import { InstanceBuilder } from './instances/builder.js';
import { LiveSet, type LiveByKind } from './instances/live-set.js';
import { InstanceManager, type ReconcileResult } from './instances/manager.js';
import {
  createInstanceStore,
  readOnlyInstanceStore,
  type InstanceStore,
} from './instances/store.js';
import {
  defaultScanDirs,
  PluginLoader,
  type BuiltinPlugin,
  type Candidate,
  type EvaluatedPlugin,
  type LoadedPlugin,
  type ScanDir,
} from './loader.js';
import { createPluginContext } from './plugin-context.js';
import type {
  LiveDestination,
  LiveNotifier,
  LiveSecretProvider,
  LiveSource,
  PluginRuntime,
} from './runtime.js';
import {
  TypeRegistry,
  type RegisteredType,
  type TypeByKind,
  type TypeEntry,
} from './type-registry.js';

export type { LoadedPlugin } from './loader.js';
export type { HotLoadResult } from './install-sync.js';
export type { ReconcileResult, ReconciledInstance } from './instances/manager.js';

export interface PluginHostOptions {
  db: Db;
  clock: Clock;
  logger: CoreLogger;
  telemetry: Telemetry;
  config: CoreConfig;
  /** Registered without discovery (tests, embedded use). */
  builtin?: BuiltinPlugin[];
  scanDirs?: ScanDir[];
  runNpm?: RunNpm;
  /** False: write nothing (plugin rows, default providers, health, error counts). */
  persist?: boolean;
}

export interface BootOptions {
  /** False: do not install or remove what other replicas recorded. */
  sync?: boolean;
}

const DEFAULT_PROVIDER_TYPES = ['env', 'file'] as const;
const SECRETS_MOUNT = '/run/secrets';

/**
 * The plugin host: loads packages, keeps their types, builds a live object per instance row and
 * converges them across replicas. A facade over the loader, registry, instance manager, install
 * sync and error counter; the pipeline and the API see it as `PluginRuntime` and
 * `PluginAdminPort`.
 */
export class PluginHost implements PluginRuntime, PluginAdminPort {
  private readonly registry = new TypeRegistry();
  private readonly live = new LiveSet();
  private readonly plugins: LoadedPlugin[] = [];
  private readonly loader: PluginLoader;
  private readonly errorCounter: PluginErrorCounter;
  private readonly catalog: PluginCatalog;
  private readonly store: InstanceStore;
  private readonly builder: InstanceBuilder;
  private readonly instances: InstanceManager;
  private readonly installs: InstallSync;
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: PluginHostOptions) {
    const { db, clock, logger, telemetry, config } = opts;
    const persist = opts.persist ?? true;
    this.catalog = persist ? createPluginCatalog(db) : readOnlyPluginCatalog;
    this.store = persist ? createInstanceStore(db) : readOnlyInstanceStore(createInstanceStore(db));
    this.loader = new PluginLoader({ config, registry: this.registry, logger });
    this.errorCounter = new PluginErrorCounter({
      telemetry,
      logger,
      persist: (name, counts) => this.catalog.addErrorCounts(name, counts),
    });
    this.builder = new InstanceBuilder({
      registry: this.registry,
      telemetry,
      contextFor: (target) =>
        createPluginContext(
          {
            db,
            clock,
            logger,
            telemetry,
            config,
            secretProvider: (name) => this.live.provider(name)?.provider,
          },
          target,
        ),
      networkOf: (pluginName) => this.loadedPlugin(pluginName)?.definition?.capabilities.network,
      resolveSettings: (settings) => this.resolveSettings(settings),
      onPluginError: (pluginName, err, context) => {
        this.errorCounter.record(
          pluginName,
          'exception',
          `${context.method}: ${errorText(err)}`,
          context,
        );
      },
    });
    this.instances = new InstanceManager({
      live: this.live,
      builder: this.builder,
      store: this.store,
      clock,
      ...(persist ? { onDropped: (id: string) => this.forgetInstanceSecrets(id) } : {}),
      logger,
      telemetry,
    });
    this.installs = new InstallSync({
      config,
      clock,
      logger,
      catalog: this.catalog,
      runNpm: opts.runNpm,
      loaded: (name) => this.loadedPlugin(name),
      loadInstalled: (name) => this.loadInstalled(name),
      unregister: (name) => this.unregister(name),
    });
  }

  /** Every package this process evaluated, in discovery order. */
  get loaded(): readonly LoadedPlugin[] {
    return this.plugins;
  }

  async boot(options: BootOptions = {}): Promise<void> {
    // Install what other replicas recorded first, so this start loads it like any other package.
    if (options.sync ?? true) await this.installs.syncInstalled({ load: false });
    await this.loadPlugins();
    await this.ensureDefaultSecretProviders();
    await this.instances.instantiateAll();
    // Anything another replica changed while this one was building.
    await this.instances.reconcile();
  }

  private async loadPlugins(): Promise<void> {
    const discovered = await discoverPlugins(
      this.opts.scanDirs ?? defaultScanDirs(this.opts.config),
    );
    const candidates: Candidate[] = this.loader.candidates(this.opts.builtin ?? [], discovered);
    const evaluated: { plugin: EvaluatedPlugin; sdkRange: string }[] = [];
    for (const candidate of candidates)
      evaluated.push({
        plugin: await this.loader.evaluate(candidate),
        sdkRange: candidate.pkg.sdk,
      });
    this.plugins.length = 0;
    this.plugins.push(...evaluated.map((e) => e.plugin));
    await this.catalog.replaceLoaded(evaluated, this.registry.list(), this.opts.clock.now());
  }

  /** Without a restart; a package whose other version is loaded waits for the next start. */
  async loadInstalled(name: string): Promise<HotLoadResult> {
    const { clock, logger, config } = this.opts;
    const dir = join(pluginsDir(config.home), 'node_modules');
    const pkg = (await discoverPlugins([{ path: dir, origin: 'installed' }])).find(
      (p) => p.name === name,
    );
    if (!pkg) throw new PluginInstallError(`${name} is not installed in ${dir}`);

    const index = this.plugins.findIndex((p) => p.name === name);
    const existing = index === -1 ? undefined : this.plugins[index];
    if (existing?.status === 'loaded') {
      return { plugin: existing, pendingRestart: existing.version !== pkg.version };
    }
    const record = await this.loader.evaluate(
      this.loader.candidate({ ...pkg, origin: 'installed' }, existing !== undefined),
    );
    if (index === -1) this.plugins.push(record);
    else this.plugins[index] = record;

    const types: RegisteredType[] = this.registry.list(name);
    await this.catalog.upsertLoaded(record, pkg.switchboard.sdk, types, clock.now());
    if (record.status === 'loaded') {
      logger.info({ plugin: name, version: record.version }, 'plugin hot-loaded');
      await this.instances.buildTypes(types);
    }
    return { plugin: record, pendingRestart: false };
  }

  installAndLoad(
    spec: string,
    runNpm?: RunNpm,
  ): Promise<{ install: InstallResult } & HotLoadResult> {
    return this.installs.installAndLoad(spec, runNpm);
  }

  forgetInstall(name: string): Promise<void> {
    return this.installs.forgetInstall(name);
  }

  syncInstalled(options?: { load: boolean }): Promise<void> {
    return this.installs.syncInstalled(options);
  }

  startSync(seconds?: number): void {
    this.installs.start(seconds);
  }

  /**
   * Idempotent. Instances that used its types rebuild and report `plugin_unavailable`. The ES
   * module cache keeps its code; a later re-install imports a fresh copy.
   */
  private async unregister(name: string): Promise<void> {
    const record = this.loadedPlugin(name);
    const dropped = this.registry.unregister(name);
    if (record && record.status !== 'removed') {
      record.status = 'removed';
      record.message = REMOVED_MESSAGE;
      delete record.definition;
      this.opts.logger.info({ plugin: name }, 'plugin removed; types unregistered');
    }
    if (dropped.length > 0) await this.instances.buildTypes(dropped);
    await this.catalog.markRemoved(name, this.opts.clock.now());
  }

  private loadedPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  /**
   * Deletes what a deleted instance rotated into a writable provider (`ctx.secrets`). Every
   * replica may do it; deletes are idempotent.
   */
  private async forgetInstanceSecrets(instanceId: string): Promise<void> {
    const prefix = instanceSecretPrefix(instanceId);
    for (const live of this.live.values('secret_provider')) {
      const provider = live.provider;
      if (!isWritableSecretProvider(provider) || typeof provider.list !== 'function') continue;
      try {
        for (const { name } of await provider.list())
          if (name.startsWith(prefix)) await provider.delete(name);
      } catch (err) {
        this.opts.logger.warn(
          { err, instance_id: instanceId, provider: live.name },
          'could not delete the credentials of a deleted instance',
        );
      }
    }
  }

  /** First boot only: runs when no secret provider is configured. */
  private async ensureDefaultSecretProviders(): Promise<void> {
    if (await this.store.hasSecretProviders()) return;
    for (const typeId of DEFAULT_PROVIDER_TYPES) {
      if (!this.registry.has('secret_provider', typeId)) continue;
      // The file provider reads mounted secrets; only default it on where the mount exists.
      if (typeId === 'file' && !(await exists(SECRETS_MOUNT))) continue;
      await this.store.addSecretProvider(typeId, this.opts.clock.now());
    }
  }

  instantiateAll(): Promise<void> {
    return this.instances.instantiateAll();
  }

  async resolveSecret(ref: string): Promise<string> {
    const parsed = parseSecretRef(ref);
    if (!parsed) throw new Error(`malformed secret reference ${ref}`);
    const provider = this.live.provider(parsed.provider);
    if (!provider)
      throw new Error(`secret provider "${parsed.provider}" is not configured or not running`);
    return provider.provider.resolve(parsed.name);
  }

  private async resolveSettings(
    settings: Record<string, unknown>,
  ): Promise<{ settings: Settings; secrets: string[] }> {
    const { value, secrets } = await resolveSecretRefs(settings, (ref) => this.resolveSecret(ref));
    return { settings: value as Settings, secrets };
  }

  async buildPreviewSource(
    typeId: string,
    settings: Record<string, unknown>,
    instanceId: string,
    name: string,
  ): Promise<PreviewSourceResult> {
    const built = await this.builder.instantiate(
      'source',
      { id: instanceId, name, typeId, settings, enabled: true, configVersion: 0 },
      { attributed: false },
    );
    if (built.ok) return built;
    return {
      ok: false,
      stage: built.stage === 'disabled' ? 'plugin' : built.stage,
      message: built.message,
      secretValues: built.secretValues,
    };
  }

  sourceType(typeId: string): TypeEntry<TypeByKind['source']> | undefined {
    return this.registry.get('source', typeId);
  }
  destinationType(typeId: string): TypeEntry<TypeByKind['destination']> | undefined {
    return this.registry.get('destination', typeId);
  }
  notifierType(typeId: string): TypeEntry<TypeByKind['notifier']> | undefined {
    return this.registry.get('notifier', typeId);
  }
  secretProviderType(typeId: string): TypeEntry<TypeByKind['secret_provider']> | undefined {
    return this.registry.get('secret_provider', typeId);
  }

  source(id: string): LiveSource | undefined {
    return this.live.get('source', id);
  }
  destination(id: string): LiveDestination | undefined {
    return this.live.get('destination', id);
  }
  notifier(id: string): LiveNotifier | undefined {
    return this.live.get('notifier', id);
  }
  secretProvider(id: string): LiveSecretProvider | undefined {
    return this.live.get('secret_provider', id);
  }

  instance<K extends InstanceKind>(kind: K, id: string): LiveByKind[K] | undefined {
    return this.live.get(kind, id);
  }

  instanceError(id: string): InstanceError | undefined {
    return this.live.error(id);
  }

  reload(kind: InstanceKind, id: string): Promise<void> {
    return this.instances.reload(kind, id);
  }

  reloadDependentsOf(
    providerNames: string | readonly string[],
  ): Promise<{ kind: Exclude<InstanceKind, 'secret_provider'>; id: string; name: string }[]> {
    return this.instances.reloadDependentsOf(providerNames);
  }

  reconcile(): Promise<ReconcileResult> {
    return this.instances.reconcile();
  }

  startReconcile(seconds = this.opts.config.instanceSyncSeconds): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.instances.reconcile();
    }, seconds * 1000);
    this.reconcileTimer.unref();
  }

  recordPluginError(pluginName: string, kind: PluginErrorKind, detail?: string): void {
    this.errorCounter.record(pluginName, kind, detail);
  }

  checkHealth(): Promise<void> {
    const { clock, telemetry } = this.opts;
    return checkAllHealth({ live: this.live, store: this.store, clock, telemetry });
  }

  async stop(): Promise<void> {
    this.installs.stop();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    await this.errorCounter.stop();
  }
}
