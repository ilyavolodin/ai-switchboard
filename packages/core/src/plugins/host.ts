import type { Settings } from '@ai-switchboard/sdk';

import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { InstanceError } from '../domain/instance-error.js';
import type { InstanceKind } from '../domain/status.js';
import type { CoreLogger } from '../logger.js';
import { forgetInstanceSecrets } from '../secrets/instance-secrets.js';
import { parseSecretRef, resolveSecretRefs } from '../secrets/refs.js';
import type { Telemetry } from '../telemetry/telemetry.js';
import { errorText } from '../util/errors.js';

import type { PluginAdminPort, PreviewSourceResult } from './admin-port.js';
import { createPluginCatalog, readOnlyPluginCatalog, type PluginCatalog } from './catalog-store.js';
import {
  PluginErrorCounter,
  type PluginErrorContext,
  type PluginErrorKind,
} from './error-counter.js';
import { checkAllHealth } from './health.js';
import type { InstallResult, RunNpm } from './install.js';
import { InstallSync } from './install-sync.js';
import { InstanceBuilder } from './instances/builder.js';
import { ensureDefaultSecretProviders } from './instances/default-providers.js';
import { LiveSet, type LiveByKind } from './instances/live-set.js';
import {
  InstanceManager,
  type DependentKind,
  type ReconciledInstance,
  type ReconcileResult,
} from './instances/manager.js';
import {
  createInstanceStore,
  readOnlyInstanceStore,
  type InstanceStore,
} from './instances/store.js';
import type { BuiltinPlugin, LoadedPlugin, ScanDir } from './loader.js';
import { createPluginContext } from './plugin-context.js';
import { PluginSet, type HotLoadResult } from './plugin-set.js';
import type {
  LiveDestination,
  LiveNotifier,
  LiveSecretProvider,
  LiveSource,
  PluginRuntime,
} from './runtime.js';
import { TypeRegistry, type TypeByKind, type TypeEntry } from './type-registry.js';

export type { LoadedPlugin } from './loader.js';
export type { HotLoadResult } from './plugin-set.js';
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

/**
 * The plugin host: a facade over the plugin set (packages and their lifecycle), the type registry,
 * the instance manager (live objects, converged across replicas), install sync and the error
 * counter. The pipeline and the API see it as `PluginRuntime` and `PluginAdminPort`.
 */
export class PluginHost implements PluginRuntime, PluginAdminPort {
  private readonly registry = new TypeRegistry();
  private readonly live = new LiveSet();
  private readonly errorCounter: PluginErrorCounter;
  private readonly catalog: PluginCatalog;
  private readonly store: InstanceStore;
  private readonly builder: InstanceBuilder;
  private readonly instances: InstanceManager;
  private readonly plugins: PluginSet;
  private readonly installs: InstallSync;
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: PluginHostOptions) {
    const { db, clock, logger, telemetry, config } = opts;
    const persist = opts.persist ?? true;
    const catalog = createPluginCatalog(db);
    const store = createInstanceStore(db);
    this.catalog = persist ? catalog : readOnlyPluginCatalog(catalog);
    this.store = persist ? store : readOnlyInstanceStore(store);
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
      networkOf: (pluginName) => this.plugins.networkOf(pluginName),
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
      ...(persist
        ? {
            onDropped: (id: string) =>
              forgetInstanceSecrets(
                this.live
                  .values('secret_provider')
                  .map((p) => ({ name: p.name, provider: p.provider })),
                id,
                logger,
              ),
          }
        : {}),
      logger,
      telemetry,
    });
    this.plugins = new PluginSet({
      config,
      clock,
      logger,
      registry: this.registry,
      catalog: this.catalog,
      rebuildTypes: (types) => this.instances.buildTypes(types),
      ...(opts.builtin ? { builtin: opts.builtin } : {}),
      ...(opts.scanDirs ? { scanDirs: opts.scanDirs } : {}),
    });
    this.installs = new InstallSync({
      config,
      clock,
      logger,
      catalog: this.catalog,
      runNpm: opts.runNpm,
      plugins: this.plugins,
    });
  }

  /** Every package this process evaluated, in discovery order. */
  get loaded(): readonly LoadedPlugin[] {
    return this.plugins.loaded;
  }

  async boot(options: BootOptions = {}): Promise<void> {
    // Install what other replicas recorded first, so this start loads it like any other package.
    if (options.sync ?? true) await this.installs.syncInstalled({ load: false });
    await this.plugins.loadAll();
    await ensureDefaultSecretProviders({
      store: this.store,
      registry: this.registry,
      clock: this.opts.clock,
    });
    await this.instances.instantiateAll();
    // Anything another replica changed while this one was building.
    await this.instances.reconcile();
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
  ): Promise<ReconciledInstance<DependentKind>[]> {
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

  recordPluginError(
    pluginName: string,
    kind: PluginErrorKind,
    detail?: string,
    context?: PluginErrorContext,
  ): void {
    this.errorCounter.record(pluginName, kind, detail, context);
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
