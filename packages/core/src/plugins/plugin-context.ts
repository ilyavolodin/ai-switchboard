import type { InstanceState, PluginContext, SecretProvider } from '@ai-switchboard/sdk';
import { createHttpClient } from '@ai-switchboard/sdk/host';
import { and, eq } from 'drizzle-orm';

import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { instanceState } from '../db/schema.js';
import { toPluginLogger, type CoreLogger } from '../logger.js';
import type { Telemetry } from '../telemetry/telemetry.js';

import { createInstanceSecrets } from './instance-secrets.js';

export interface PluginContextDeps {
  db: Db;
  clock: Clock;
  logger: CoreLogger;
  telemetry: Pick<Telemetry, 'tracedFetch'>;
  config: Pick<CoreConfig, 'publicUrl'>;
  /** A running secret provider by name, looked up at call time. */
  secretProvider(name: string): SecretProvider | undefined;
}

export interface ContextTarget {
  instanceId: string;
  instanceName: string;
  pluginName: string;
  /** The plugin's declared `capabilities.network`; undefined allows any host. */
  network: string[] | undefined;
  /** The settings as stored (with `secret://` references): they say where rotated values go. */
  settings: Record<string, unknown>;
  /** Resolved setting values; the state store refuses any value that carries one. */
  secretValues: readonly string[];
}

/** Shorter values would match ordinary text by accident. */
const MIN_GUARDED_LENGTH = 8;

export class SecretInStateError extends Error {
  override readonly name = 'SecretInStateError';
}

/**
 * Instance state is a Postgres row. A value that carries a credential the host knows about (a
 * resolved setting, or anything that went through `ctx.secrets`) is refused, not stored.
 */
export function guardInstanceState(
  state: InstanceState,
  known: ReadonlySet<string>,
): InstanceState {
  return {
    get: (key) => state.get(key),
    set: async (key, value) => {
      const text = value === undefined ? '' : JSON.stringify(value);
      for (const secret of known) {
        if (secret.length >= MIN_GUARDED_LENGTH && text.includes(secret))
          throw new SecretInStateError(
            `instance state "${key}" would hold a credential; keep it in ctx.secrets instead`,
          );
      }
      await state.set(key, value);
    },
  };
}

export function createInstanceStateStore(db: Db, clock: Clock, instanceId: string): InstanceState {
  return {
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
        .values({ instanceId, key, value, updatedAt: clock.now() })
        .onConflictDoUpdate({
          target: [instanceState.instanceId, instanceState.key],
          set: { value, updatedAt: clock.now() },
        });
    },
  };
}

export function createPluginContext(deps: PluginContextDeps, target: ContextTarget): PluginContext {
  const coreLogger = deps.logger.child({
    plugin: target.pluginName,
    instance_id: target.instanceId,
  });
  const logger = toPluginLogger(coreLogger);
  const known = new Set(target.secretValues);
  return {
    instanceId: target.instanceId,
    instanceName: target.instanceName,
    logger,
    http: createHttpClient({
      ...(target.network ? { allowedHosts: target.network } : {}),
      logger,
      fetch: deps.telemetry.tracedFetch(),
    }),
    now: () => deps.clock.now(),
    publicUrl: deps.config.publicUrl,
    state: guardInstanceState(
      createInstanceStateStore(deps.db, deps.clock, target.instanceId),
      known,
    ),
    secrets: createInstanceSecrets({
      instanceId: target.instanceId,
      settings: target.settings,
      provider: (name) => deps.secretProvider(name),
      logger: coreLogger,
      known,
    }),
  };
}
