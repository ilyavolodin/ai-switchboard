import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createHttpClient,
  isInvokeError,
  isPluginDefinition,
  isTransportError,
  SDK_MAJOR,
  SDK_VERSION,
  validatePlugin,
  type ExecutorType,
  type Health,
  type NotifierType,
  type PluginContext,
  type PluginDefinition,
  type SecretProviderType,
  type Settings,
  type SourceType,
} from '@ai-switchboard/sdk';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import semver from 'semver';

import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import {
  executors,
  instanceState,
  notifiers,
  plugins,
  pluginTypes,
  secretProviders,
  sources,
} from '../db/schema.js';
import { toPluginLogger, type CoreLogger } from '../logger.js';
import { parseSecretRef, referencesProvider, resolveSecretRefs } from '../secrets/refs.js';
import type { Telemetry } from '../telemetry/telemetry.js';
import { discoverPlugins, type DiscoveredPackage } from './discovery.js';
import {
  installPlugin,
  listInstalled,
  pluginsDir,
  PluginInstallError,
  removePlugin,
  specPackageName,
  type InstallResult,
  type RunNpm,
} from './install.js';
import { diffInstances } from './reconcile.js';
import {
  typeInvokeTimeout,
  type LiveExecutor,
  type LiveNotifier,
  type LiveSecretProvider,
  type LiveSource,
  type PluginRuntime,
} from './runtime.js';

export type InstanceKind = 'source' | 'executor' | 'notifier' | 'secret_provider';

export interface LoadedPlugin {
  name: string;
  version: string;
  origin: 'baked' | 'installed';
  /** `removed`: an admin removed it while this process ran; its types are unregistered. */
  status: 'loaded' | 'failed' | 'incompatible' | 'removed';
  message?: string;
  definition?: PluginDefinition;
}

export interface PluginHostOptions {
  db: Db;
  clock: Clock;
  logger: CoreLogger;
  telemetry: Telemetry;
  config: CoreConfig;
  /** Plugin definitions registered without discovery (tests, embedded use). */
  builtin?: { name: string; version: string; definition: PluginDefinition }[];
  /** Replace the default scan directories. */
  scanDirs?: { path: string; origin: 'baked' | 'installed' }[];
  /** `npm` runner for installs (injectable for tests). */
  runNpm?: RunNpm;
}

/** What loading one installed package did. */
export interface HotLoadResult {
  plugin: LoadedPlugin;
  /**
   * True when the running process cannot pick the package up: a different version of it is
   * already loaded (the ES module cache keeps the old code) and a restart applies the change.
   */
  pendingRestart: boolean;
}

/** A package the host is about to validate and register. */
interface Candidate {
  pkg: Pick<DiscoveredPackage, 'name' | 'version' | 'origin'> & { sdk: string };
  load: () => Promise<unknown>;
}

interface TypeEntry<T> {
  type: T;
  pluginName: string;
}

/** The row version this replica built an instance from (see {@link PluginHost.reconcile}). */
interface BuiltInstance {
  kind: InstanceKind;
  version: number;
  name: string;
}

/** One instance a reconcile pass built, rebuilt or dropped. */
export interface ReconciledInstance {
  kind: InstanceKind;
  id: string;
  name: string;
}

/** What one {@link PluginHost.reconcile} pass did on this replica. */
export interface ReconcileResult {
  /** Rows this replica had never built (created on another replica). */
  built: ReconciledInstance[];
  /** Rows whose version moved on (changed, enabled, disabled or reloaded elsewhere). */
  rebuilt: ReconciledInstance[];
  /** Instances whose row is gone (deleted elsewhere). */
  dropped: ReconciledInstance[];
  /** Instances rebuilt because a secret provider they reference changed. */
  dependents: ReconciledInstance[];
}

const INSTANCE_TABLES = {
  source: sources,
  executor: executors,
  notifier: notifiers,
  secret_provider: secretProviders,
} as const;

const REMOVED_MESSAGE = 'removed by an admin';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors a plugin raises on purpose to describe a backend outcome; not counted as plugin bugs. */
function isExpectedError(err: unknown): boolean {
  return isTransportError(err) || isInvokeError(err);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The serializable part of a type, stored in `plugin_types.manifest` and served to the UI. */
export function serializeType(
  kind: InstanceKind,
  type: SourceType | ExecutorType | NotifierType | SecretProviderType,
): Record<string, unknown> {
  const base = {
    displayName: type.displayName,
    description: type.description,
    ...(type.icon !== undefined ? { icon: type.icon } : {}),
    settingsSchema: type.settingsSchema,
  };
  if (kind === 'source') {
    const t = type as SourceType;
    return {
      ...base,
      mode: t.mode,
      eventTypes: t.eventTypes,
      actions: t.actions ?? [],
      dynamicEventTypes: t.dynamicEventTypes ?? false,
      allowsUnauthenticated: t.allowsUnauthenticated ?? false,
    };
  }
  if (kind === 'executor') {
    const t = type as ExecutorType;
    return {
      ...base,
      targetSchema: t.targetSchema,
      inputSchema: t.inputSchema,
      tracking: t.tracking,
      idempotentInvoke: t.idempotentInvoke,
      usage: t.usage,
      meters: t.meters ?? [],
      actions: t.actions ?? [],
      examples: t.examples ?? [],
    };
  }
  return base;
}

/**
 * Wrap every method of a plugin object so an unexpected exception is attributed to its plugin
 * before it propagates. Sync methods stay sync.
 */
function attribute<T extends object>(
  target: T,
  onError: (err: unknown, method: string) => void,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        try {
          const out = fn.apply(obj, args);
          if (out instanceof Promise) {
            return out.catch((err: unknown) => {
              if (!isExpectedError(err)) onError(err, String(prop));
              throw err;
            });
          }
          return out;
        } catch (err) {
          if (!isExpectedError(err)) onError(err, String(prop));
          throw err;
        }
      };
    },
  });
}

export class PluginHost implements PluginRuntime {
  readonly loaded: LoadedPlugin[] = [];
  private readonly types = {
    source: new Map<string, TypeEntry<SourceType>>(),
    executor: new Map<string, TypeEntry<ExecutorType>>(),
    notifier: new Map<string, TypeEntry<NotifierType>>(),
    secret_provider: new Map<string, TypeEntry<SecretProviderType>>(),
  };
  private readonly liveSources = new Map<string, LiveSource>();
  private readonly liveExecutors = new Map<string, LiveExecutor>();
  private readonly liveNotifiers = new Map<string, LiveNotifier>();
  private readonly liveProviders = new Map<string, LiveSecretProvider>();
  private readonly providersByName = new Map<string, LiveSecretProvider>();
  private readonly errors = new Map<string, string>();
  /** Build tickets: see {@link commit}. */
  private buildEpoch = 0;
  private readonly claims = new Map<string, number>();
  /** The row version behind each committed build: what {@link reconcile} compares against. */
  private readonly built = new Map<string, BuiltInstance>();
  /** Instances with a reload in flight on this replica; a reconcile pass leaves them alone. */
  private readonly pending = new Map<string, number>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling: Promise<ReconcileResult> | undefined;
  private readonly pluginErrorQueue = new Map<
    string,
    { exception: number; invalid_event: number; invalid_usage: number }
  >();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: PluginHostOptions) {}

  // ------------------------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------------------------

  /** Discover, load and register plugins, then build every configured instance. */
  async boot(): Promise<void> {
    // Install what other replicas recorded first, so this start loads it like any other package.
    await this.syncInstalled({ load: false });
    await this.loadPlugins();
    await this.ensureDefaultSecretProviders();
    await this.instantiateAll();
    // Anything another replica changed while this one was building.
    await this.reconcile();
  }

  defaultScanDirs(): { path: string; origin: 'baked' | 'installed' }[] {
    const coreNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    return [
      { path: join(this.opts.config.home, 'plugins', 'node_modules'), origin: 'installed' },
      ...this.opts.config.pluginDirs.map((path) => ({ path, origin: 'installed' as const })),
      { path: coreNodeModules, origin: 'baked' },
      { path: join(process.cwd(), 'node_modules'), origin: 'baked' },
    ];
  }

  private async importDefinition(pkg: DiscoveredPackage, query = ''): Promise<unknown> {
    const entry = join(pkg.dir, pkg.switchboard.entry);
    const source = pkg.switchboard.source ? join(pkg.dir, pkg.switchboard.source) : undefined;
    const useSource =
      source !== undefined && (this.opts.config.devSource || !(await exists(entry)));
    const file = useSource ? source : entry;
    const mod = (await import(`${pathToFileURL(file).href}${query}`)) as { default?: unknown };
    return mod.default;
  }

  /** Validate one candidate like boot does and, when it passes, register its types. */
  private async evaluate({ pkg, load }: Candidate): Promise<LoadedPlugin> {
    const record: LoadedPlugin = {
      name: pkg.name,
      version: pkg.version,
      origin: pkg.origin,
      status: 'loaded',
    };
    try {
      if (!semver.satisfies(SDK_VERSION, pkg.sdk, { includePrerelease: true })) {
        record.status = 'incompatible';
        record.message = `declares sdk ${pkg.sdk}; running SDK is ${SDK_VERSION}`;
      } else {
        const def = await load();
        if (!isPluginDefinition(def)) {
          record.status = 'failed';
          record.message = 'default export is not a definePlugin() result';
        } else if (def.switchboardSdk.major !== SDK_MAJOR) {
          record.status = 'incompatible';
          record.message = `built against SDK major ${def.switchboardSdk.major}`;
        } else {
          const problems = validatePlugin(def);
          const clash = this.findClash(def);
          if (problems.length > 0) {
            record.status = 'failed';
            record.message = problems.slice(0, 5).join('; ');
          } else if (clash) {
            record.status = 'failed';
            record.message = clash;
          } else {
            record.definition = def;
            this.registerTypes(pkg.name, def);
          }
        }
      }
    } catch (err) {
      record.status = 'failed';
      record.message = err instanceof Error ? err.message : String(err);
    }
    if (record.status !== 'loaded')
      this.opts.logger.warn(
        { plugin: pkg.name, status: record.status, reason: record.message },
        'plugin not loaded',
      );
    return record;
  }

  /** The `plugins` row for a loaded (or refused) package. Install columns are left alone. */
  private pluginRow(p: LoadedPlugin, sdkRange: string, now: Date) {
    const def = p.definition;
    return {
      name: p.name,
      pluginId: def?.id ?? p.name,
      displayName: def?.displayName ?? p.name,
      version: p.version,
      sdkRange,
      capabilities: def?.capabilities ?? {},
      status: p.status,
      statusMessage: p.message ?? null,
      origin: p.origin,
      loadedAt: p.status === 'loaded' ? now : null,
      updatedAt: now,
    };
  }

  /** The `plugin_types` rows of every type a plugin registered. */
  private typeRows(pluginName: string | undefined, now: Date) {
    const rows = [];
    for (const kind of ['source', 'executor', 'notifier', 'secret_provider'] as const) {
      for (const [typeId, entry] of this.types[kind]) {
        if (pluginName !== undefined && entry.pluginName !== pluginName) continue;
        rows.push({
          plugin: entry.pluginName,
          kind: kind,
          typeId,
          displayName: entry.type.displayName,
          manifest: serializeType(kind, entry.type),
          available: true,
          updatedAt: now,
        });
      }
    }
    return rows;
  }

  async loadPlugins(): Promise<void> {
    const { db, clock } = this.opts;
    const discovered = await discoverPlugins(this.opts.scanDirs ?? this.defaultScanDirs());
    const candidates: Candidate[] = [
      ...(this.opts.builtin ?? []).map((b) => ({
        pkg: {
          name: b.name,
          version: b.version,
          origin: 'baked' as const,
          sdk: `^${SDK_MAJOR}.0.0`,
        },
        load: () => Promise.resolve(b.definition as unknown),
      })),
      ...discovered.map((pkg) => ({
        pkg: { name: pkg.name, version: pkg.version, origin: pkg.origin, sdk: pkg.switchboard.sdk },
        load: () => this.importDefinition(pkg),
      })),
    ];

    this.loaded.length = 0;
    for (const candidate of candidates) this.loaded.push(await this.evaluate(candidate));

    const now = clock.now();
    await db.transaction(async (tx) => {
      const present = new Set<string>();
      for (const p of this.loaded) {
        present.add(p.name);
        const values = this.pluginRow(
          p,
          candidates.find((c) => c.pkg.name === p.name)?.pkg.sdk ?? '',
          now,
        );
        await tx
          .insert(plugins)
          .values(values)
          .onConflictDoUpdate({ target: plugins.name, set: values });
      }
      // Plugins seen before but missing now are unavailable; their types too.
      const rows = await tx
        .select({ name: plugins.name, removeRequestedAt: plugins.removeRequestedAt })
        .from(plugins);
      for (const row of rows) {
        if (!present.has(row.name)) {
          await tx
            .update(plugins)
            .set({
              status: 'unavailable',
              statusMessage: row.removeRequestedAt ? REMOVED_MESSAGE : 'package not found at boot',
              loadedAt: null,
              updatedAt: now,
            })
            .where(eq(plugins.name, row.name));
        }
      }
      await tx.update(pluginTypes).set({ available: false, updatedAt: now });
      for (const values of this.typeRows(undefined, now)) {
        await tx
          .insert(pluginTypes)
          .values(values)
          .onConflictDoUpdate({ target: [pluginTypes.kind, pluginTypes.typeId], set: values });
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // Hot install and replica convergence
  // ------------------------------------------------------------------------------------------

  /** Serializes npm runs in this process: the API and the sync timer share one plugins dir. */
  private installChain: Promise<unknown> = Promise.resolve();
  private syncTimer: NodeJS.Timeout | undefined;
  private importGeneration = 0;

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.installChain.then(fn, fn);
    this.installChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Load a package that was just installed into `$SWITCHBOARD_HOME/plugins`, without a restart:
   * import its entry, validate it like boot, register its types, upsert its `plugins` and
   * `plugin_types` rows and build the configured instances that were waiting for its types.
   * A package whose other version is already loaded is left for the next start.
   */
  async loadInstalled(name: string): Promise<HotLoadResult> {
    const { db, clock, logger } = this.opts;
    const dir = join(pluginsDir(this.opts.config.home), 'node_modules');
    const pkg = (await discoverPlugins([{ path: dir, origin: 'installed' }])).find(
      (p) => p.name === name,
    );
    if (!pkg) throw new PluginInstallError(`${name} is not installed in ${dir}`);

    const index = this.loaded.findIndex((p) => p.name === name);
    const existing = index === -1 ? undefined : this.loaded[index];
    if (existing?.status === 'loaded') {
      return { plugin: existing, pendingRestart: existing.version !== pkg.version };
    }
    // A failed earlier import stays in the ES module cache under its URL: import a fresh copy.
    const bust = existing ? `?v=${encodeURIComponent(pkg.version)}.${++this.importGeneration}` : '';
    const record = await this.evaluate({
      pkg: { name: pkg.name, version: pkg.version, origin: 'installed', sdk: pkg.switchboard.sdk },
      load: () => this.importDefinition(pkg, bust),
    });
    if (index === -1) this.loaded.push(record);
    else this.loaded[index] = record;

    const now = clock.now();
    const typeRows = this.typeRows(name, now);
    await db.transaction(async (tx) => {
      const values = this.pluginRow(record, pkg.switchboard.sdk, now);
      await tx
        .insert(plugins)
        .values(values)
        .onConflictDoUpdate({ target: plugins.name, set: values });
      for (const values of typeRows) {
        await tx
          .insert(pluginTypes)
          .values(values)
          .onConflictDoUpdate({ target: [pluginTypes.kind, pluginTypes.typeId], set: values });
      }
    });
    if (record.status === 'loaded') {
      logger.info({ plugin: name, version: record.version }, 'plugin hot-loaded');
      await this.buildInstancesOf(typeRows.map((t) => ({ kind: t.kind, typeId: t.typeId })));
    }
    return { plugin: record, pendingRestart: false };
  }

  /** Build the configured instances of freshly registered types. */
  private async buildInstancesOf(types: { kind: InstanceKind; typeId: string }[]): Promise<void> {
    const { db } = this.opts;
    const ticket = this.ticket();
    const ids = (kind: InstanceKind) => types.filter((t) => t.kind === kind).map((t) => t.typeId);
    const providerTypes = ids('secret_provider');
    if (providerTypes.length > 0) {
      const rows = await db
        .select()
        .from(secretProviders)
        .where(inArray(secretProviders.typeId, providerTypes));
      for (const row of rows) this.buildSecretProvider(row, ticket);
      // Instances that failed on these providers' references resolve them now.
      if (rows.length > 0) await this.reloadDependentsOf(rows.map((r) => r.name));
    }
    const sourceTypes = ids('source');
    if (sourceTypes.length > 0)
      for (const row of await db.select().from(sources).where(inArray(sources.typeId, sourceTypes)))
        await this.buildSource(row, ticket);
    const executorTypes = ids('executor');
    if (executorTypes.length > 0)
      for (const row of await db
        .select()
        .from(executors)
        .where(inArray(executors.typeId, executorTypes)))
        await this.buildExecutor(row, ticket);
    const notifierTypes = ids('notifier');
    if (notifierTypes.length > 0)
      for (const row of await db
        .select()
        .from(notifiers)
        .where(inArray(notifiers.typeId, notifierTypes)))
        await this.buildNotifier(row, ticket);
  }

  /**
   * Install a package from npm (admin action), record it in the database so every replica
   * converges on it, and load it into this process.
   */
  async installAndLoad(
    spec: string,
    runNpm: RunNpm | undefined = this.opts.runNpm,
  ): Promise<{ install: InstallResult } & HotLoadResult> {
    return this.serialized(async () => {
      const install = await installPlugin({
        home: this.opts.config.home,
        spec,
        allowSource: this.opts.config.devSource,
        ...(runNpm ? { runNpm } : {}),
        now: () => this.opts.clock.now(),
      });
      await this.recordInstall(install.name, spec, install.version, install.sdkRange);
      const loaded = await this.loadInstalled(install.name);
      return { install, ...loaded };
    });
  }

  /** Remember an API install in `plugins` (the row may not exist yet on this replica). */
  private async recordInstall(
    name: string,
    spec: string,
    version: string,
    sdkRange: string,
  ): Promise<void> {
    const now = this.opts.clock.now();
    // Re-installing clears a removal tombstone.
    const install = {
      installSpec: spec,
      installVersion: version,
      installedAt: now,
      removeRequestedAt: null,
    };
    await this.opts.db
      .insert(plugins)
      .values({
        name,
        pluginId: name,
        displayName: name,
        version,
        sdkRange,
        status: 'unavailable',
        statusMessage: 'installed; loading',
        origin: 'installed',
        ...install,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: plugins.name, set: { ...install, origin: 'installed' } });
  }

  /**
   * Record an admin's removal: forget the API install and set the tombstone, so every replica's
   * sync pass removes its own copy and unregisters it (see {@link syncInstalled}). This process
   * unregisters it now; the caller has already removed the local package.
   */
  async forgetInstall(name: string): Promise<void> {
    const now = this.opts.clock.now();
    await this.opts.db
      .update(plugins)
      .set({ installSpec: null, installVersion: null, removeRequestedAt: now, updatedAt: now })
      .where(eq(plugins.name, name));
    await this.unregister(name);
  }

  /**
   * Take a removed plugin out of this process: drop its types, rebuild the instances that used
   * them (they report `plugin_unavailable`) and mark its rows unavailable. Idempotent. The ES
   * module cache keeps its code; a later re-install imports a fresh copy.
   */
  private async unregister(name: string): Promise<void> {
    const { db, clock, logger } = this.opts;
    const record = this.loaded.find((p) => p.name === name);
    const dropped: { kind: InstanceKind; typeId: string }[] = [];
    for (const kind of ['source', 'executor', 'notifier', 'secret_provider'] as const) {
      for (const [typeId, entry] of this.types[kind]) {
        if (entry.pluginName !== name) continue;
        this.types[kind].delete(typeId);
        dropped.push({ kind, typeId });
      }
    }
    if (record && record.status !== 'removed') {
      record.status = 'removed';
      record.message = REMOVED_MESSAGE;
      delete record.definition;
      logger.info({ plugin: name }, 'plugin removed; types unregistered');
    }
    if (dropped.length > 0) await this.buildInstancesOf(dropped);
    const now = clock.now();
    await db.transaction(async (tx) => {
      await tx
        .update(plugins)
        .set({
          status: 'unavailable',
          statusMessage: REMOVED_MESSAGE,
          loadedAt: null,
          updatedAt: now,
        })
        .where(and(eq(plugins.name, name), isNotNull(plugins.removeRequestedAt)));
      await tx
        .update(pluginTypes)
        .set({ available: false, updatedAt: now })
        .where(eq(pluginTypes.plugin, name));
    });
  }

  /**
   * Converge this replica on the database: install every plugin recorded by an API install that
   * is missing from (or at another version in) the local `$SWITCHBOARD_HOME`, and with `load`,
   * hot-load it; remove every tombstoned plugin from the local home and unregister it. A copy
   * installed locally after the removal (a CLI install) is left alone, as are plugins that were
   * never recorded. Idempotent; failures are logged and retried on the next pass, never thrown.
   */
  async syncInstalled(options: { load: boolean } = { load: true }): Promise<void> {
    const { db, logger, config } = this.opts;
    let rows: {
      name: string;
      installSpec: string | null;
      installVersion: string | null;
      removeRequestedAt: Date | null;
    }[];
    try {
      rows = await db
        .select({
          name: plugins.name,
          installSpec: plugins.installSpec,
          installVersion: plugins.installVersion,
          removeRequestedAt: plugins.removeRequestedAt,
        })
        .from(plugins)
        .where(or(isNotNull(plugins.installSpec), isNotNull(plugins.removeRequestedAt)));
    } catch (err) {
      logger.error({ err }, 'could not read recorded plugin installs');
      return;
    }
    if (rows.length === 0) return;
    const recorded = rows.filter((r) => r.installSpec !== null);
    const tombstoned = rows.filter(
      (r): r is typeof r & { removeRequestedAt: Date } =>
        r.installSpec === null && r.removeRequestedAt !== null,
    );
    await this.serialized(async () => {
      const local = await listInstalled(config.home).catch(() => []);
      for (const row of tombstoned) {
        try {
          const have = local.find((l) => l.name === row.name);
          const installedAt = have ? Date.parse(have.installedAt) : Number.NaN;
          // Installed here after the removal (e.g. with the CLI): a newer decision, keep it.
          if (have && installedAt > row.removeRequestedAt.getTime()) continue;
          if (have) {
            logger.info(
              { plugin: row.name },
              'removing a plugin an admin removed on another replica',
            );
            await removePlugin({
              home: config.home,
              name: row.name,
              ...(this.opts.runNpm ? { runNpm: this.opts.runNpm } : {}),
            });
          }
          const current = this.loaded.find((p) => p.name === row.name);
          if (current?.origin === 'installed' && current.status !== 'removed')
            await this.unregister(row.name);
        } catch (err) {
          logger.error({ err, plugin: row.name }, 'could not remove a removed plugin');
        }
      }
      for (const row of recorded) {
        if (!row.installSpec) continue;
        const have = local.find((l) => l.name === row.name);
        const wanted = row.installVersion ?? have?.version;
        try {
          if (!have || (wanted !== undefined && have.version !== wanted)) {
            // Pin registry specs to the recorded version so every replica runs the same code.
            const spec =
              specPackageName(row.installSpec) === row.name && row.installVersion
                ? `${row.name}@${row.installVersion}`
                : row.installSpec;
            logger.info(
              { plugin: row.name, spec },
              'installing a plugin recorded by another replica',
            );
            await installPlugin({
              home: config.home,
              spec,
              allowSource: config.devSource,
              ...(this.opts.runNpm ? { runNpm: this.opts.runNpm } : {}),
              now: () => this.opts.clock.now(),
            });
          }
          // Load it unless this process already tried this version (a refused package is not
          // re-imported every pass; a new version is).
          const current = this.loaded.find((p) => p.name === row.name);
          const tried =
            current !== undefined &&
            current.status !== 'removed' &&
            (current.status === 'loaded' || current.version === (wanted ?? current.version));
          if (options.load && !tried) await this.loadInstalled(row.name);
        } catch (err) {
          logger.error({ err, plugin: row.name }, 'could not install a recorded plugin');
        }
      }
    });
  }

  /** Run {@link syncInstalled} every `seconds` on this replica until {@link stop}. */
  startSync(seconds = this.opts.config.pluginSyncSeconds): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      void this.syncInstalled();
    }, seconds * 1000);
    this.syncTimer.unref();
  }

  private findClash(def: PluginDefinition): string | undefined {
    const pairs: [InstanceKind, { id: string }[]][] = [
      ['source', def.sources],
      ['executor', def.executors],
      ['notifier', def.notifiers],
      ['secret_provider', def.secretProviders],
    ];
    for (const [kind, list] of pairs) {
      for (const t of list) {
        const existing = this.types[kind].get(t.id);
        if (existing) return `${kind} type "${t.id}" is already provided by ${existing.pluginName}`;
      }
    }
    return undefined;
  }

  private registerTypes(pluginName: string, def: PluginDefinition): void {
    for (const t of def.sources) this.types.source.set(t.id, { type: t, pluginName });
    for (const t of def.executors) this.types.executor.set(t.id, { type: t, pluginName });
    for (const t of def.notifiers) this.types.notifier.set(t.id, { type: t, pluginName });
    for (const t of def.secretProviders)
      this.types.secret_provider.set(t.id, { type: t, pluginName });
  }

  /** First boot: create `env` and `file` provider instances when their types exist and none are configured. */
  private async ensureDefaultSecretProviders(): Promise<void> {
    const { db, clock } = this.opts;
    const existing = await db.select({ id: secretProviders.id }).from(secretProviders).limit(1);
    if (existing.length > 0) return;
    for (const typeId of ['env', 'file']) {
      if (!this.types.secret_provider.has(typeId)) continue;
      // The file provider reads mounted secrets; only default it on where the mount exists.
      if (typeId === 'file' && !(await exists('/run/secrets'))) continue;
      await db
        .insert(secretProviders)
        .values({
          typeId,
          name: typeId,
          settings: {},
          enabled: true,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        })
        .onConflictDoNothing();
    }
  }

  async instantiateAll(): Promise<void> {
    const { db } = this.opts;
    const ticket = this.ticket();
    for (const row of await db.select().from(secretProviders))
      this.buildSecretProvider(row, ticket);
    for (const row of await db.select().from(sources)) await this.buildSource(row, ticket);
    for (const row of await db.select().from(executors)) await this.buildExecutor(row, ticket);
    for (const row of await db.select().from(notifiers)) await this.buildNotifier(row, ticket);
  }

  // ------------------------------------------------------------------------------------------
  // Instances
  // ------------------------------------------------------------------------------------------

  private context(
    instanceId: string,
    instanceName: string,
    pluginName: string,
    network: string[] | undefined,
  ): PluginContext {
    const { logger, clock, config, telemetry, db } = this.opts;
    const pluginLogger = toPluginLogger(
      logger.child({ plugin: pluginName, instance_id: instanceId }),
    );
    return {
      instanceId,
      instanceName,
      logger: pluginLogger,
      http: createHttpClient({
        ...(network ? { allowedHosts: network } : {}),
        logger: pluginLogger,
        injectHeaders: () => telemetry.traceHeaders(),
      }),
      now: () => clock.now(),
      publicUrl: config.publicUrl,
      state: {
        get: async <T>(key: string) => {
          const rows = await db
            .select({ value: instanceState.value })
            .from(instanceState)
            .where(and(eq(instanceState.instanceId, instanceId), eq(instanceState.key, key)));
          return rows[0]?.value as T | undefined;
        },
        set: async (key: string, value: unknown) => {
          await db
            .insert(instanceState)
            .values({ instanceId, key, value: value, updatedAt: clock.now() })
            .onConflictDoUpdate({
              target: [instanceState.instanceId, instanceState.key],
              set: { value: value, updatedAt: clock.now() },
            });
        },
      },
    };
  }

  private pluginCapabilities(pluginName: string): string[] | undefined {
    return this.loaded.find((p) => p.name === pluginName)?.definition?.capabilities.network;
  }

  /** Resolve `secret://<provider>/<name>` through the provider instance named `<provider>`. */
  async resolveSecret(ref: string): Promise<string> {
    const parsed = parseSecretRef(ref);
    if (!parsed) throw new Error(`malformed secret reference ${ref}`);
    const provider = this.providersByName.get(parsed.provider);
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

  private attributeFor(pluginName: string, instanceId: string) {
    return (err: unknown, method: string): void => {
      this.opts.logger.error(
        { err, plugin: pluginName, instance_id: instanceId, method },
        'plugin exception',
      );
      this.recordPluginError(
        pluginName,
        'exception',
        `${method}: ${err instanceof Error ? err.message : String(err)}`,
      );
    };
  }

  private clearInstance(id: string): void {
    this.liveSources.delete(id);
    this.liveExecutors.delete(id);
    this.liveNotifiers.delete(id);
    const provider = this.liveProviders.get(id);
    if (provider) this.providersByName.delete(provider.name);
    this.liveProviders.delete(id);
    this.errors.delete(id);
  }

  /** A new build ticket. Take it before reading the rows the build uses. */
  private ticket(): number {
    return ++this.buildEpoch;
  }

  /**
   * Swap in what a build produced, unless a build holding a later ticket (so one that read a
   * newer row) has claimed the instance. Until the swap the previous object keeps serving, so a
   * reload never leaves a gap while secrets resolve.
   */
  private commit(
    id: string,
    ticket: number,
    apply: () => void,
    from: BuiltInstance | undefined,
  ): boolean {
    if ((this.claims.get(id) ?? 0) > ticket) return false;
    this.claims.set(id, ticket);
    this.clearInstance(id);
    apply();
    // `from` is the row the build read; without one the row is gone and so is the instance.
    if (from) this.built.set(id, from);
    else this.built.delete(id);
    return true;
  }

  private fail(id: string, ticket: number, error: string, from: BuiltInstance): void {
    this.commit(id, ticket, () => this.errors.set(id, error), from);
  }

  /** Mark instances as being rebuilt by this replica until `fn` settles. */
  private async withPending<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T> {
    for (const id of ids) this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const id of ids) {
        const n = (this.pending.get(id) ?? 1) - 1;
        if (n > 0) this.pending.set(id, n);
        else this.pending.delete(id);
      }
    }
  }

  private async markResolved(kind: 'source' | 'executor', id: string): Promise<void> {
    const table = kind === 'source' ? sources : executors;
    try {
      await this.opts.db
        .update(table)
        .set({ secretsResolvedAt: this.opts.clock.now() })
        .where(eq(table.id, id));
    } catch (err) {
      // Only the "last resolved" time shown in the UI is lost; the instance is running.
      this.opts.logger.warn({ err, instance_id: id }, 'could not record secret resolution');
    }
  }

  private buildSecretProvider(row: typeof secretProviders.$inferSelect, ticket: number): void {
    const from: BuiltInstance = {
      kind: 'secret_provider',
      version: row.configVersion,
      name: row.name,
    };
    const entry = this.types.secret_provider.get(row.typeId);
    if (!entry) {
      this.fail(row.id, ticket, 'plugin_unavailable', from);
      return;
    }
    if (!row.enabled) {
      this.fail(row.id, ticket, 'disabled', from);
      return;
    }
    let live: LiveSecretProvider;
    try {
      const ctx = this.context(
        row.id,
        row.name,
        entry.pluginName,
        this.pluginCapabilities(entry.pluginName),
      );
      const provider = attribute(
        entry.type.create(row.settings, ctx),
        this.attributeFor(entry.pluginName, row.id),
      );
      live = { id: row.id, name: row.name, typeId: row.typeId, type: entry.type, provider };
    } catch (err) {
      this.fail(row.id, ticket, `create_failed: ${errorText(err)}`, from);
      return;
    }
    this.commit(
      row.id,
      ticket,
      () => {
        this.liveProviders.set(row.id, live);
        this.providersByName.set(row.name, live);
      },
      from,
    );
  }

  private async buildSource(row: typeof sources.$inferSelect, ticket: number): Promise<void> {
    const from: BuiltInstance = { kind: 'source', version: row.configVersion, name: row.name };
    const entry = this.types.source.get(row.typeId);
    if (!entry) {
      this.fail(row.id, ticket, 'plugin_unavailable', from);
      return;
    }
    let resolved: { settings: Settings; secrets: string[] };
    try {
      resolved = await this.resolveSettings(row.settings);
    } catch (err) {
      this.fail(row.id, ticket, `secret_error: ${errorText(err)}`, from);
      return;
    }
    let live: LiveSource;
    try {
      const ctx = this.context(
        row.id,
        row.name,
        entry.pluginName,
        this.pluginCapabilities(entry.pluginName),
      );
      const source = attribute(
        entry.type.create(resolved.settings, ctx),
        this.attributeFor(entry.pluginName, row.id),
      );
      const eventTypes =
        entry.type.dynamicEventTypes && entry.type.instanceEventTypes
          ? entry.type.instanceEventTypes(resolved.settings)
          : entry.type.eventTypes;
      live = {
        id: row.id,
        name: row.name,
        typeId: row.typeId,
        pluginName: entry.pluginName,
        type: entry.type,
        source,
        eventTypes,
        secretValues: resolved.secrets,
      };
    } catch (err) {
      this.recordPluginError(entry.pluginName, 'exception', `create: ${errorText(err)}`);
      this.fail(row.id, ticket, `create_failed: ${errorText(err)}`, from);
      return;
    }
    const committed = this.commit(
      row.id,
      ticket,
      () => {
        this.liveSources.set(row.id, live);
        if (!row.enabled) this.errors.set(row.id, 'disabled');
      },
      from,
    );
    if (committed) await this.markResolved('source', row.id);
  }

  private async buildExecutor(row: typeof executors.$inferSelect, ticket: number): Promise<void> {
    const from: BuiltInstance = { kind: 'executor', version: row.configVersion, name: row.name };
    const entry = this.types.executor.get(row.typeId);
    if (!entry) {
      this.fail(row.id, ticket, 'plugin_unavailable', from);
      return;
    }
    let resolved: { settings: Settings; secrets: string[] };
    try {
      resolved = await this.resolveSettings(row.settings);
    } catch (err) {
      this.fail(row.id, ticket, `secret_error: ${errorText(err)}`, from);
      return;
    }
    let live: LiveExecutor;
    try {
      const type = entry.type;
      const ctx = this.context(
        row.id,
        row.name,
        entry.pluginName,
        this.pluginCapabilities(entry.pluginName),
      );
      const executor = attribute(
        type.create(resolved.settings, ctx),
        this.attributeFor(entry.pluginName, row.id),
      );
      live = {
        id: row.id,
        name: row.name,
        typeId: row.typeId,
        pluginName: entry.pluginName,
        type,
        executor,
        usage: type.usageFor ? type.usageFor(resolved.settings) : type.usage,
        meters: type.metersFor ? type.metersFor(resolved.settings) : (type.meters ?? []),
        trackingFor: (target) => (type.trackingFor ? type.trackingFor(target) : type.tracking),
        idempotentFor: (target) =>
          type.idempotentFor ? type.idempotentFor(target) : type.idempotentInvoke,
        invokeTimeoutFor: (target) => typeInvokeTimeout(type, target),
        secretValues: resolved.secrets,
      };
    } catch (err) {
      this.recordPluginError(entry.pluginName, 'exception', `create: ${errorText(err)}`);
      this.fail(row.id, ticket, `create_failed: ${errorText(err)}`, from);
      return;
    }
    const committed = this.commit(
      row.id,
      ticket,
      () => {
        this.liveExecutors.set(row.id, live);
        if (!row.enabled) this.errors.set(row.id, 'disabled');
      },
      from,
    );
    if (committed) await this.markResolved('executor', row.id);
  }

  private async buildNotifier(row: typeof notifiers.$inferSelect, ticket: number): Promise<void> {
    const from: BuiltInstance = { kind: 'notifier', version: row.configVersion, name: row.name };
    const entry = this.types.notifier.get(row.typeId);
    if (!entry) {
      this.fail(row.id, ticket, 'plugin_unavailable', from);
      return;
    }
    let settings: Settings;
    try {
      ({ settings } = await this.resolveSettings(row.settings));
    } catch (err) {
      this.fail(row.id, ticket, `secret_error: ${errorText(err)}`, from);
      return;
    }
    let live: LiveNotifier;
    try {
      const ctx = this.context(
        row.id,
        row.name,
        entry.pluginName,
        this.pluginCapabilities(entry.pluginName),
      );
      const notifier = attribute(
        entry.type.create(settings, ctx),
        this.attributeFor(entry.pluginName, row.id),
      );
      live = { id: row.id, name: row.name, typeId: row.typeId, type: entry.type, notifier };
    } catch (err) {
      this.fail(row.id, ticket, `create_failed: ${errorText(err)}`, from);
      return;
    }
    this.commit(
      row.id,
      ticket,
      () => {
        this.liveNotifiers.set(row.id, live);
        if (!row.enabled) this.errors.set(row.id, 'disabled');
      },
      from,
    );
  }

  // ------------------------------------------------------------------------------------------
  // PluginRuntime
  // ------------------------------------------------------------------------------------------

  sourceType(typeId: string): TypeEntry<SourceType> | undefined {
    return this.types.source.get(typeId);
  }
  executorType(typeId: string): TypeEntry<ExecutorType> | undefined {
    return this.types.executor.get(typeId);
  }
  notifierType(typeId: string): TypeEntry<NotifierType> | undefined {
    return this.types.notifier.get(typeId);
  }
  secretProviderType(typeId: string): TypeEntry<SecretProviderType> | undefined {
    return this.types.secret_provider.get(typeId);
  }

  typesOf(kind: InstanceKind): {
    typeId: string;
    pluginName: string;
    type: SourceType | ExecutorType | NotifierType | SecretProviderType;
  }[] {
    return [...this.types[kind].entries()].map(([typeId, e]) => ({
      typeId,
      pluginName: e.pluginName,
      type: e.type,
    }));
  }

  source(id: string): LiveSource | undefined {
    return this.liveSources.get(id);
  }
  executor(id: string): LiveExecutor | undefined {
    return this.liveExecutors.get(id);
  }
  notifier(id: string): LiveNotifier | undefined {
    return this.liveNotifiers.get(id);
  }
  secretProvider(id: string): LiveSecretProvider | undefined {
    return this.liveProviders.get(id);
  }

  instanceError(id: string): string | undefined {
    return this.errors.get(id);
  }

  /**
   * Rebuild one instance from its row now (the replica that changed it). Other replicas pick
   * the change up on their next {@link reconcile} pass through the row's `config_version`; this
   * one records the version it built, so its own pass does not build it again.
   */
  async reload(kind: InstanceKind, id: string): Promise<void> {
    // Claim the instance before reading its row: an older build finishing later cannot win.
    const ticket = this.ticket();
    this.claims.set(id, ticket);
    await this.withPending([id], () => this.rebuild(kind, id, ticket));
  }

  private async rebuild(kind: InstanceKind, id: string, ticket: number): Promise<void> {
    const { db } = this.opts;
    switch (kind) {
      case 'source': {
        const [row] = await db.select().from(sources).where(eq(sources.id, id));
        if (row) await this.buildSource(row, ticket);
        else this.commit(id, ticket, () => undefined, undefined);
        return;
      }
      case 'executor': {
        const [row] = await db.select().from(executors).where(eq(executors.id, id));
        if (row) await this.buildExecutor(row, ticket);
        else this.commit(id, ticket, () => undefined, undefined);
        return;
      }
      case 'notifier': {
        const [row] = await db.select().from(notifiers).where(eq(notifiers.id, id));
        if (row) await this.buildNotifier(row, ticket);
        else this.commit(id, ticket, () => undefined, undefined);
        return;
      }
      case 'secret_provider': {
        const [row] = await db.select().from(secretProviders).where(eq(secretProviders.id, id));
        if (row) this.buildSecretProvider(row, ticket);
        else this.commit(id, ticket, () => undefined, undefined);
        return;
      }
    }
  }

  /**
   * Rebuild every source, executor and notifier whose settings reference
   * `secret://<provider>/…` for one of these provider names, so they re-resolve against the
   * provider as it is now: created, enabled, disabled, re-configured, renamed (pass the old and
   * the new name: instances still naming the old one fail with a `secret_error`) or deleted.
   * Returns the instances it rebuilt.
   */
  async reloadDependentsOf(
    providerNames: string | readonly string[],
  ): Promise<{ kind: 'source' | 'executor' | 'notifier'; id: string; name: string }[]> {
    const { db } = this.opts;
    const names = new Set(typeof providerNames === 'string' ? [providerNames] : providerNames);
    if (names.size === 0) return [];
    // Claim before reading the rows, like reload(): an older build finishing later cannot win.
    const ticket = this.ticket();
    const rebuilt: { kind: 'source' | 'executor' | 'notifier'; id: string; name: string }[] = [];
    const claim = (id: string): void => {
      this.claims.set(id, ticket);
    };
    const sourceRows = (await db.select().from(sources)).filter((r) =>
      referencesProvider(r.settings, names),
    );
    const executorRows = (await db.select().from(executors)).filter((r) =>
      referencesProvider(r.settings, names),
    );
    const notifierRows = (await db.select().from(notifiers)).filter((r) =>
      referencesProvider(r.settings, names),
    );
    const ids = [...sourceRows, ...executorRows, ...notifierRows].map((r) => r.id);
    for (const id of ids) claim(id);
    await this.withPending(ids, async () => {
      for (const row of sourceRows) {
        await this.buildSource(row, ticket);
        rebuilt.push({ kind: 'source', id: row.id, name: row.name });
      }
      for (const row of executorRows) {
        await this.buildExecutor(row, ticket);
        rebuilt.push({ kind: 'executor', id: row.id, name: row.name });
      }
      for (const row of notifierRows) {
        await this.buildNotifier(row, ticket);
        rebuilt.push({ kind: 'notifier', id: row.id, name: row.name });
      }
    });
    if (rebuilt.length > 0)
      this.opts.logger.info(
        { providers: [...names], instances: rebuilt.length },
        'rebuilt instances that reference a secret provider',
      );
    return rebuilt;
  }

  // ------------------------------------------------------------------------------------------
  // Instance convergence across replicas
  // ------------------------------------------------------------------------------------------

  /**
   * Converge this replica's live objects on the instance tables: build instances another
   * replica created, rebuild the ones whose `config_version` moved on (changed, enabled,
   * disabled or reloaded elsewhere), drop the deleted ones, and rebuild the dependents of every
   * secret provider that changed. One `id, config_version` query per table; only changed rows
   * are read in full. Instances with a reload in flight here are left for the next pass. A pass
   * never throws (failures are logged) and concurrent calls share one pass.
   */
  reconcile(): Promise<ReconcileResult> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<ReconcileResult> {
    const result: ReconcileResult = { built: [], rebuilt: [], dropped: [], dependents: [] };
    try {
      // Providers first: their dependents resolve against the providers as they are now.
      const names = new Set<string>();
      const providers = await this.reconcileKind('secret_provider', result);
      for (const p of providers) {
        names.add(p.name);
        if (p.previousName !== undefined) names.add(p.previousName);
      }
      if (names.size > 0) {
        result.dependents = await this.reloadDependentsOf([...names]);
        for (const d of result.dependents) this.countRebuild(d.kind, 'dependent');
      }
      for (const kind of ['source', 'executor', 'notifier'] as const)
        await this.reconcileKind(kind, result);
    } catch (err) {
      this.opts.logger.error({ err }, 'could not reconcile instances with the database');
    }
    const changes =
      result.built.length +
      result.rebuilt.length +
      result.dropped.length +
      result.dependents.length;
    if (changes > 0)
      this.opts.logger.info(
        {
          built: result.built.length,
          rebuilt: result.rebuilt.length,
          dropped: result.dropped.length,
          dependents: result.dependents.length,
        },
        'converged instances changed on another replica',
      );
    else this.opts.logger.debug('instances already converged');
    return result;
  }

  /** Reconcile one instance table; returns the touched instances with their previous names. */
  private async reconcileKind(
    kind: InstanceKind,
    result: ReconcileResult,
  ): Promise<(ReconciledInstance & { previousName?: string })[]> {
    const { db } = this.opts;
    // Take the ticket before reading any row, like every other build.
    const ticket = this.ticket();
    const table = INSTANCE_TABLES[kind];
    const rows = await db.select({ id: table.id, version: table.configVersion }).from(table);
    const built = new Map<string, number>();
    for (const [id, b] of this.built) if (b.kind === kind) built.set(id, b.version);
    const diff = diffInstances(
      rows,
      built,
      (id) => this.pending.has(id) || (this.claims.get(id) ?? 0) > ticket,
    );
    const touched: (ReconciledInstance & { previousName?: string })[] = [];
    const changed = new Set(diff.changed);
    const ids = [...diff.added, ...diff.changed];
    // The names built before: a renamed provider's dependents on the old name rebuild too.
    const previous = new Map(ids.map((id) => [id, this.built.get(id)?.name]));
    for (const row of ids.length > 0 ? await this.buildRows(kind, ids, ticket) : []) {
      const before = previous.get(row.id);
      const entry = { kind, id: row.id, name: row.name };
      const wasChanged = changed.has(row.id);
      (wasChanged ? result.rebuilt : result.built).push(entry);
      touched.push({
        ...entry,
        ...(before !== undefined && before !== row.name ? { previousName: before } : {}),
      });
      this.countRebuild(kind, wasChanged ? 'changed' : 'created');
      this.opts.logger.debug(
        { kind, instance_id: row.id, version: row.version },
        wasChanged
          ? 'rebuilt an instance changed elsewhere'
          : 'built an instance created elsewhere',
      );
    }
    for (const id of diff.removed) {
      const before = this.built.get(id);
      if (!before || !this.commit(id, ticket, () => undefined, undefined)) continue;
      const entry = { kind, id, name: before.name };
      result.dropped.push(entry);
      touched.push(entry);
      this.countRebuild(kind, 'removed');
      this.opts.logger.debug({ kind, instance_id: id }, 'dropped an instance deleted elsewhere');
    }
    return touched;
  }

  /** Read these rows of one table in full and build each; returns what was read. */
  private async buildRows(
    kind: InstanceKind,
    ids: string[],
    ticket: number,
  ): Promise<{ id: string; name: string; version: number }[]> {
    const { db } = this.opts;
    const head = (r: { id: string; name: string; configVersion: number }) => ({
      id: r.id,
      name: r.name,
      version: r.configVersion,
    });
    switch (kind) {
      case 'secret_provider': {
        const rows = await db
          .select()
          .from(secretProviders)
          .where(inArray(secretProviders.id, ids));
        for (const row of rows) this.buildSecretProvider(row, ticket);
        return rows.map(head);
      }
      case 'source': {
        const rows = await db.select().from(sources).where(inArray(sources.id, ids));
        for (const row of rows) await this.buildSource(row, ticket);
        return rows.map(head);
      }
      case 'executor': {
        const rows = await db.select().from(executors).where(inArray(executors.id, ids));
        for (const row of rows) await this.buildExecutor(row, ticket);
        return rows.map(head);
      }
      case 'notifier': {
        const rows = await db.select().from(notifiers).where(inArray(notifiers.id, ids));
        for (const row of rows) await this.buildNotifier(row, ticket);
        return rows.map(head);
      }
    }
  }

  private countRebuild(
    kind: InstanceKind,
    change: 'created' | 'changed' | 'removed' | 'dependent',
  ): void {
    this.opts.telemetry.counter('switchboard.instance.rebuilds', { kind, change });
  }

  /** Run {@link reconcile} every `seconds` on this replica until {@link stop}. */
  startReconcile(seconds = this.opts.config.instanceSyncSeconds): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, seconds * 1000);
    this.reconcileTimer.unref();
  }

  recordPluginError(
    pluginName: string,
    kind: 'exception' | 'invalid_event' | 'invalid_usage',
    detail?: string,
  ): void {
    this.opts.telemetry.counter('switchboard.plugin.errors', { plugin: pluginName, kind });
    if (detail) this.opts.logger.warn({ plugin: pluginName, kind, detail }, 'plugin error');
    const counts = this.pluginErrorQueue.get(pluginName) ?? {
      exception: 0,
      invalid_event: 0,
      invalid_usage: 0,
    };
    counts[kind]++;
    this.pluginErrorQueue.set(pluginName, counts);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPluginErrors();
    }, 250);
  }

  /** Persist buffered plugin error counts. */
  async flushPluginErrors(): Promise<void> {
    const pending = [...this.pluginErrorQueue.entries()];
    this.pluginErrorQueue.clear();
    for (const [name, c] of pending) {
      try {
        await this.opts.db
          .update(plugins)
          .set({
            errorCount: sql`${plugins.errorCount} + ${c.exception + c.invalid_usage}`,
            invalidEventCount: sql`${plugins.invalidEventCount} + ${c.invalid_event}`,
          })
          .where(eq(plugins.name, name));
      } catch (err) {
        this.opts.logger.error({ err, plugin: name }, 'could not record plugin errors');
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------------------------------

  private async probe(fn: () => Promise<Health>): Promise<Health> {
    const now = this.opts.clock.now().toISOString();
    try {
      return await Promise.race([
        fn(),
        new Promise<Health>((resolve) =>
          setTimeout(
            () =>
              resolve({ status: 'unhealthy', message: 'health check timed out', checkedAt: now }),
            10_000,
          ).unref(),
        ),
      ]);
    } catch (err) {
      return {
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: now,
      };
    }
  }

  /** Call every live instance's `health()` and store the result on its row. */
  async checkHealth(): Promise<void> {
    const { db, telemetry } = this.opts;
    for (const live of this.liveSources.values()) {
      const health = await this.probe(() => live.source.health());
      await db.update(sources).set({ health }).where(eq(sources.id, live.id));
      telemetry.gauge('switchboard.source.health', health.status === 'healthy' ? 1 : 0, {
        instance: live.name,
      });
    }
    for (const live of this.liveExecutors.values()) {
      const [row] = await db
        .select({ health: executors.health })
        .from(executors)
        .where(eq(executors.id, live.id));
      const health = await this.probe(() => live.executor.health());
      // An executor marked unhealthy by the pipeline (401/403) stays so until a reload or a healthy probe.
      if (row?.health?.status === 'unhealthy' && health.status === 'unknown') continue;
      await db.update(executors).set({ health }).where(eq(executors.id, live.id));
      telemetry.gauge('switchboard.executor.health', health.status === 'healthy' ? 1 : 0, {
        instance: live.name,
      });
    }
    for (const live of this.liveNotifiers.values()) {
      const health = await this.probe(() => live.notifier.health());
      await db.update(notifiers).set({ health }).where(eq(notifiers.id, live.id));
    }
    for (const live of this.liveProviders.values()) {
      const health = await this.probe(() => live.provider.health());
      await db.update(secretProviders).set({ health }).where(eq(secretProviders.id, live.id));
    }
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flushPluginErrors();
  }
}
