import type { Health } from '@ai-switchboard/sdk';

import type { Clock } from '../clock.js';
import { INSTANCE_KINDS, type InstanceKind } from '../domain/status.js';
import type { GaugeName, Telemetry } from '../telemetry/telemetry.js';
import { errorText } from '../util/errors.js';
import { withTimeout } from '../util/timeout.js';

import { KIND_SPECS } from './instances/kind-specs.js';
import type { LiveSet } from './instances/live-set.js';
import type { InstanceStore } from './instances/store.js';

export const HEALTH_TIMEOUT_MS = 10_000;

/** Never throws: a thrown or timed-out check is `unhealthy` with the reason. */
export async function probeHealth(
  check: () => Promise<Health>,
  clock: Clock,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<Health> {
  const checkedAt = clock.now().toISOString();
  try {
    return await withTimeout(check(), timeoutMs, 'health check timed out');
  } catch (err) {
    return { status: 'unhealthy', message: errorText(err), checkedAt };
  }
}

const HEALTH_GAUGES: Partial<Record<InstanceKind, GaugeName>> = {
  source: 'switchboard.source.health',
  destination: 'switchboard.destination.health',
};

export interface HealthDeps {
  live: LiveSet;
  store: InstanceStore;
  clock: Clock;
  telemetry: Pick<Telemetry, 'gauge'>;
}

/**
 * Probes every live instance and stores the result. A destination keeps an `unhealthy` the
 * pipeline set (401/403) when the probe cannot tell.
 */
export async function checkAllHealth(deps: HealthDeps): Promise<void> {
  for (const kind of INSTANCE_KINDS) await checkKind(kind, deps);
}

async function checkKind<K extends InstanceKind>(kind: K, deps: HealthDeps): Promise<void> {
  for (const live of deps.live.values(kind)) {
    const object = KIND_SPECS[kind].objectOf(live);
    const stored = kind === 'destination' ? await deps.store.health(kind, live.id) : null;
    const health = await probeHealth(() => object.health(), deps.clock);
    if (stored?.status === 'unhealthy' && health.status === 'unknown') continue;
    await deps.store.saveHealth(kind, live.id, health);
    const gauge = HEALTH_GAUGES[kind];
    if (gauge)
      deps.telemetry.gauge(gauge, health.status === 'healthy' ? 1 : 0, { instance: live.name });
  }
}
