import type { Clock } from '../../clock.js';
import type { InstanceKind } from '../../domain/status.js';
import type { CoreLogger } from '../../logger.js';
import { referencesProvider } from '../../secrets/refs.js';
import type { Telemetry } from '../../telemetry/telemetry.js';

import { DISABLED, buildError, type InstanceBuilder } from './builder.js';
import { BUILD_ORDER, healthSeries, recordsResolution } from './kind-specs.js';
import type { BuiltInstance, LiveSet } from './live-set.js';
import { diffInstances } from './reconcile.js';
import type { InstanceRowHead, InstanceStore } from './store.js';

export interface ReconciledInstance<K extends InstanceKind = InstanceKind> {
  kind: K;
  id: string;
  name: string;
}

/** The kinds whose settings may reference a secret provider. */
export type DependentKind = Exclude<InstanceKind, 'secret_provider'>;

export interface ReconcileResult {
  built: ReconciledInstance[];
  rebuilt: ReconciledInstance[];
  dropped: ReconciledInstance[];
  /** Instances rebuilt because a secret provider they reference changed. */
  dependents: ReconciledInstance<DependentKind>[];
}

const DEPENDENT_KINDS: readonly DependentKind[] = ['source', 'destination', 'notifier'];

type RebuildChange = 'created' | 'changed' | 'removed' | 'dependent';

export interface InstanceManagerDeps {
  live: LiveSet;
  builder: InstanceBuilder;
  store: InstanceStore;
  clock: Clock;
  logger: CoreLogger;
  telemetry: Pick<Telemetry, 'decision' | 'clearGauge'>;
  /** The row is gone: release what the instance kept outside Postgres. Never throws. */
  onDropped?(id: string): Promise<void>;
}

/**
 * Builds, reloads and converges the live objects of one replica on the instance tables. Other
 * replicas pick a change up on their next reconcile pass through `config_version`.
 */
export class InstanceManager {
  private reconciling: Promise<ReconcileResult> | undefined;

  constructor(private readonly deps: InstanceManagerDeps) {}

  async build(kind: InstanceKind, row: InstanceRowHead, ticket: number): Promise<void> {
    const { live, builder, store, clock, logger } = this.deps;
    const from: BuiltInstance = { kind, version: row.configVersion, name: row.name };
    const built = await builder.instantiate(kind, row, { attributed: true });
    const outcome = built.ok
      ? {
          kind,
          live: built.live,
          ...(!row.enabled ? { error: DISABLED } : {}),
        }
      : { error: buildError(built.stage, built.message) };
    const committed = live.commit(row.id, ticket, outcome, from);
    if (!committed || !built.ok || !recordsResolution(kind)) return;
    try {
      await store.markSecretsResolved(kind, row.id, clock.now());
    } catch (err) {
      // Only the "last resolved" time shown in the UI is lost; the instance is running.
      logger.warn({ err, instance_id: row.id }, 'could not record secret resolution');
    }
  }

  async instantiateAll(): Promise<void> {
    const ticket = this.deps.live.ticket();
    for (const kind of BUILD_ORDER)
      for (const row of await this.deps.store.rows(kind)) await this.build(kind, row, ticket);
  }

  /** After a plugin's types came or went: rebuild every instance of them. */
  async buildTypes(types: readonly { kind: InstanceKind; typeId: string }[]): Promise<void> {
    const ticket = this.deps.live.ticket();
    for (const kind of BUILD_ORDER) {
      const typeIds = types.filter((t) => t.kind === kind).map((t) => t.typeId);
      if (typeIds.length === 0) continue;
      const rows = await this.deps.store.rows(kind, { typeIds });
      for (const row of rows) await this.build(kind, row, ticket);
      // Instances that failed on these providers' references resolve them now.
      if (kind === 'secret_provider' && rows.length > 0)
        await this.reloadDependentsOf(rows.map((r) => r.name));
    }
  }

  async reload(kind: InstanceKind, id: string): Promise<void> {
    const { live, store } = this.deps;
    const ticket = live.ticket();
    live.claim(id, ticket);
    await live.withPending([id], async () => {
      const [row] = await store.rows(kind, { ids: [id] });
      if (row) await this.build(kind, row, ticket);
      else if (live.commit(id, ticket, undefined, undefined)) await this.dropped(kind, id);
    });
  }

  /**
   * Rebuilds every instance whose settings reference `secret://<provider>/…` for these names. On a
   * rename pass the old and the new name: instances still naming the old one fail with a
   * `secret_error`.
   */
  async reloadDependentsOf(
    providerNames: string | readonly string[],
  ): Promise<ReconciledInstance<DependentKind>[]> {
    const { live, store, logger } = this.deps;
    const names = new Set(typeof providerNames === 'string' ? [providerNames] : providerNames);
    if (names.size === 0) return [];
    const ticket = live.ticket();
    const targets: { kind: DependentKind; row: InstanceRowHead }[] = [];
    for (const kind of DEPENDENT_KINDS)
      for (const row of await store.rows(kind))
        if (referencesProvider(row.settings, names)) targets.push({ kind, row });
    const ids = targets.map((t) => t.row.id);
    for (const id of ids) live.claim(id, ticket);
    const rebuilt: ReconciledInstance<DependentKind>[] = [];
    await live.withPending(ids, async () => {
      for (const { kind, row } of targets) {
        await this.build(kind, row, ticket);
        rebuilt.push({ kind, id: row.id, name: row.name });
      }
    });
    if (rebuilt.length > 0)
      logger.info(
        { providers: [...names], instances: rebuilt.length },
        'rebuilt instances that reference a secret provider',
      );
    return rebuilt;
  }

  /**
   * Converges live objects on the instance tables by `config_version`, and rebuilds the
   * dependents of every secret provider that changed. Only changed rows are read in full. Never
   * throws (failures are logged); concurrent calls share one pass.
   */
  reconcile(): Promise<ReconcileResult> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<ReconcileResult> {
    const { logger } = this.deps;
    const result: ReconcileResult = { built: [], rebuilt: [], dropped: [], dependents: [] };
    try {
      const names = new Set<string>();
      for (const p of await this.reconcileKind('secret_provider', result)) {
        names.add(p.name);
        if (p.previousName !== undefined) names.add(p.previousName);
      }
      if (names.size > 0) {
        result.dependents = await this.reloadDependentsOf([...names]);
        for (const d of result.dependents) this.countRebuild(d.kind, 'dependent', d.id);
      }
      for (const kind of DEPENDENT_KINDS) await this.reconcileKind(kind, result);
    } catch (err) {
      logger.error({ err }, 'could not reconcile instances with the database');
    }
    const counts = {
      built: result.built.length,
      rebuilt: result.rebuilt.length,
      dropped: result.dropped.length,
      dependents: result.dependents.length,
    };
    if (counts.built + counts.rebuilt + counts.dropped + counts.dependents > 0)
      logger.info(counts, 'converged instances changed on another replica');
    else logger.debug('instances already converged');
    return result;
  }

  /** Returns the touched instances with their previous names. */
  private async reconcileKind(
    kind: InstanceKind,
    result: ReconcileResult,
  ): Promise<(ReconciledInstance & { previousName?: string })[]> {
    const { live, store } = this.deps;
    const ticket = live.ticket();
    const diff = diffInstances(await store.versions(kind), live.builtVersions(kind), (id) =>
      live.busy(id, ticket),
    );
    const touched: (ReconciledInstance & { previousName?: string })[] = [];
    const changed = new Set(diff.changed);
    const ids = [...diff.added, ...diff.changed];
    // The names built before: a renamed provider's dependents on the old name rebuild too.
    const previous = new Map(ids.map((id) => [id, live.builtOf(id)?.name]));
    const rows = ids.length > 0 ? await store.rows(kind, { ids }) : [];
    for (const row of rows) {
      await this.build(kind, row, ticket);
      const before = previous.get(row.id);
      const entry = { kind, id: row.id, name: row.name };
      const wasChanged = changed.has(row.id);
      (wasChanged ? result.rebuilt : result.built).push(entry);
      touched.push({
        ...entry,
        ...(before !== undefined && before !== row.name ? { previousName: before } : {}),
      });
      this.countRebuild(kind, wasChanged ? 'changed' : 'created', row.id);
    }
    for (const id of diff.removed) {
      const before = live.builtOf(id);
      if (!before || !live.commit(id, ticket, undefined, undefined)) continue;
      await this.dropped(kind, id);
      const entry = { kind, id, name: before.name };
      result.dropped.push(entry);
      touched.push(entry);
      this.countRebuild(kind, 'removed', id);
    }
    return touched;
  }

  /** The row is gone: release what the instance kept outside Postgres and its gauge series. */
  private async dropped(kind: InstanceKind, id: string): Promise<void> {
    const series = healthSeries(kind, id);
    if (series) this.deps.telemetry.clearGauge(series.name, series.attributes);
    await this.deps.onDropped?.(id);
  }

  /** One decision per instance another replica changed: a metric and a log line. */
  private countRebuild(kind: InstanceKind, change: RebuildChange, instanceId: string): void {
    this.deps.telemetry.decision(
      'switchboard.instance.rebuilds',
      { kind, change },
      { instance_id: instanceId },
    );
  }
}
