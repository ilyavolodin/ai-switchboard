import type { Deps } from '../../deps.js';

/** What a read model needs: no queue, logger or telemetry, and nothing from the HTTP layer. */
export type ReadDeps = Pick<Deps, 'db' | 'clock' | 'runtime' | 'config'>;
