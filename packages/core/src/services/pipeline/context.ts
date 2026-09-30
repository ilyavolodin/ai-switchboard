import type { Deps } from '../../deps.js';
import type { ExpressionEngine } from '../../expr/index.js';
import type { CoreLogger } from '../../logger.js';

export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export interface PipelineDeps extends Deps {
  secrets: SecretResolver;
  /** 0 disables the timer (tests). Default 30 000. */
  heartbeatIntervalMs?: number;
  /** Non-secret values for `$env`; defaults to `process.env` filtered by prefix. */
  env?: Record<string, string | undefined>;
}

export interface Ctx extends PipelineDeps {
  engine: ExpressionEngine;
  log: CoreLogger;
}
