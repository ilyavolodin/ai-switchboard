import type { Clock } from './clock.js';
import type { CoreConfig } from './config.js';
import type { Db } from './db/client.js';
import type { CoreLogger } from './logger.js';
import type { PluginRuntime } from './plugins/runtime.js';
import type { JobQueue } from './queue/queue.js';
import type { Telemetry } from './telemetry/telemetry.js';

/** Everything a service needs, passed explicitly. */
export interface Deps {
  db: Db;
  clock: Clock;
  runtime: PluginRuntime;
  queue: JobQueue;
  logger: CoreLogger;
  telemetry: Telemetry;
  config: CoreConfig;
}
