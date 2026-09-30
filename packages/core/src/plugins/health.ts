import type { Health } from '@ai-switchboard/sdk';

import type { Clock } from '../clock.js';
import { INSTANCE_KINDS, type InstanceKind } from '../domain/status.js';
import type { Telemetry } from '../telemetry/telemetry.js';
import { errorText } from '../util/errors.js';

import { healthSeries, KIND_SPECS } from './instances/kind-specs.js';
import type { LiveByKind, LiveSet } from './instances/live-set.js';
import type { InstanceStore } from './instances/store.js';

/** Probes in flight at once, so one hanging backend does not hold up every other check. */
export const HEALTH_CONCURRENCY = 8;

/**
 * Never throws: a thrown or timed-out check is `unhealthy` with the reason. The limit comes from
 * the plugin call wrapper (`HEALTH_TIMEOUT_MS`), which also counts it against the plugin.
 */
export async function probeHealth(check: () => Promise<Health>, clock: Clock): Promise<Health> {
  const checkedAt = clock.now().toISOString();
  try {
    return await check();
  } catch (err) {
    return { status: 'unhealthy', message: errorText(err), checkedAt };
  }
}

export interface HealthDeps {
  live: LiveSet;
  store: InstanceStore;
  clock: Clock;
  telemetry: Pick<Telemetry, 'gauge'>;
  concurrency?: number;
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Probes every live instance, a few at a time, and stores the result. */
export async function checkAllHealth(deps: HealthDeps): Promise<void> {
  const checks = INSTANCE_KINDS.flatMap((kind) => checksOf(kind, deps));
  await forEachLimited(checks, deps.concurrency ?? HEALTH_CONCURRENCY, (check) => check());
}

function checksOf<K extends InstanceKind>(kind: K, deps: HealthDeps): (() => Promise<void>)[] {
  return deps.live.values(kind).map((live) => () => checkOne(kind, live, deps));
}

async function checkOne<K extends InstanceKind>(
  kind: K,
  live: LiveByKind[K],
  deps: HealthDeps,
): Promise<void> {
  const spec = KIND_SPECS[kind];
  const object = spec.objectOf(live);
  const stored = spec.keepsStoredUnhealthy ? await deps.store.health(kind, live.id) : null;
  const health = await probeHealth(() => object.health(), deps.clock);
  if (stored?.status === 'unhealthy' && health.status === 'unknown') return;
  await deps.store.saveHealth(kind, live.id, health);
  const series = healthSeries(kind, live.id);
  if (series)
    deps.telemetry.gauge(series.name, health.status === 'healthy' ? 1 : 0, series.attributes);
}
