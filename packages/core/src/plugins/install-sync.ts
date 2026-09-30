import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { CoreLogger } from '../logger.js';

import type { PluginCatalog } from './catalog-store.js';
import { withHomeLock } from './home-lock.js';
import {
  installPlugin,
  listInstalled,
  removePlugin,
  specPackageName,
  type InstallResult,
  type RunNpm,
} from './install.js';
import type { HotLoadResult, PluginSet } from './plugin-set.js';

export type { HotLoadResult } from './plugin-set.js';

export interface InstallSyncDeps {
  config: Pick<CoreConfig, 'home' | 'devSource' | 'pluginSyncSeconds'>;
  clock: Clock;
  logger: CoreLogger;
  catalog: PluginCatalog;
  runNpm: RunNpm | undefined;
  plugins: Pick<PluginSet, 'get' | 'hotLoad' | 'unregister'>;
}

/**
 * Keeps this replica's plugins directory on what admins recorded in the database. Every npm run
 * holds the home's lock (`withHomeLock`), which also orders it against the CLI.
 */
export class InstallSync {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: InstallSyncDeps) {}

  private npm(runNpm: RunNpm | undefined = this.deps.runNpm): { runNpm?: RunNpm } {
    return runNpm ? { runNpm } : {};
  }

  /** Records the install in the database so every replica converges on it. */
  installAndLoad(
    spec: string,
    runNpm: RunNpm | undefined = this.deps.runNpm,
  ): Promise<{ install: InstallResult } & HotLoadResult> {
    const { config, clock, catalog } = this.deps;
    return withHomeLock(config.home, async () => {
      const install = await installPlugin({
        home: config.home,
        spec,
        allowSource: config.devSource,
        ...this.npm(runNpm),
        now: () => clock.now(),
        locked: true,
      });
      await catalog.recordInstall(
        { name: install.name, spec, version: install.version, sdkRange: install.sdkRange },
        clock.now(),
      );
      const loaded = await this.deps.plugins.hotLoad(install.name);
      return { install, ...loaded };
    });
  }

  /**
   * Sets the tombstone so every replica's sync pass removes its own copy. The caller has already
   * removed the local package.
   */
  async forgetInstall(name: string): Promise<void> {
    await this.deps.catalog.tombstone(name, this.deps.clock.now());
    await this.deps.plugins.unregister(name);
  }

  /**
   * Installs recorded plugins missing locally (or at another version) and removes tombstoned ones.
   * A copy installed locally after the removal (a CLI install) is left alone, as are plugins that
   * were never recorded. Never throws: failures are logged and retried on the next pass.
   */
  async syncInstalled(options: { load: boolean } = { load: true }): Promise<void> {
    const { config, logger, catalog } = this.deps;
    let rows: Awaited<ReturnType<PluginCatalog['readInstallRecords']>>;
    try {
      rows = await catalog.readInstallRecords();
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
    try {
      await withHomeLock(config.home, async () => {
        const local = await listInstalled(config.home).catch(() => []);
        for (const row of tombstoned) await this.removeTombstoned(row, local);
        for (const row of recorded) await this.installRecorded(row, local, options.load);
      });
    } catch (err) {
      logger.error({ err }, 'could not sync recorded plugin installs');
    }
  }

  private async removeTombstoned(
    row: { name: string; removeRequestedAt: Date },
    local: Awaited<ReturnType<typeof listInstalled>>,
  ): Promise<void> {
    const { config, logger } = this.deps;
    try {
      const have = local.find((l) => l.name === row.name);
      const installedAt = have ? Date.parse(have.installedAt) : Number.NaN;
      // Installed here after the removal (e.g. with the CLI): a newer decision, keep it.
      if (have && installedAt > row.removeRequestedAt.getTime()) return;
      if (have) {
        logger.info({ plugin: row.name }, 'removing a plugin an admin removed on another replica');
        await removePlugin({ home: config.home, name: row.name, ...this.npm(), locked: true });
      }
      const current = this.deps.plugins.get(row.name);
      if (current?.origin === 'installed' && current.status !== 'removed')
        await this.deps.plugins.unregister(row.name);
    } catch (err) {
      logger.error({ err, plugin: row.name }, 'could not remove a removed plugin');
    }
  }

  private async installRecorded(
    row: { name: string; installSpec: string | null; installVersion: string | null },
    local: Awaited<ReturnType<typeof listInstalled>>,
    load: boolean,
  ): Promise<void> {
    const { config, clock, logger } = this.deps;
    if (!row.installSpec) return;
    const have = local.find((l) => l.name === row.name);
    const wanted = row.installVersion ?? have?.version;
    try {
      if (!have || (wanted !== undefined && have.version !== wanted)) {
        // Pin registry specs to the recorded version so every replica runs the same code.
        const spec =
          specPackageName(row.installSpec) === row.name && row.installVersion
            ? `${row.name}@${row.installVersion}`
            : row.installSpec;
        logger.info({ plugin: row.name, spec }, 'installing a plugin recorded by another replica');
        await installPlugin({
          home: config.home,
          spec,
          allowSource: config.devSource,
          ...this.npm(),
          now: () => clock.now(),
          locked: true,
        });
      }
      // Load it unless this process already tried this version (a refused package is not
      // re-imported every pass; a new version is).
      const current = this.deps.plugins.get(row.name);
      const tried =
        current !== undefined &&
        current.status !== 'removed' &&
        (current.status === 'loaded' || current.version === (wanted ?? current.version));
      if (load && !tried) await this.deps.plugins.hotLoad(row.name);
    } catch (err) {
      logger.error({ err, plugin: row.name }, 'could not install a recorded plugin');
    }
  }

  start(seconds = this.deps.config.pluginSyncSeconds): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncInstalled();
    }, seconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
