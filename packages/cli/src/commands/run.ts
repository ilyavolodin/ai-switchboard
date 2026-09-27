import type { CliDeps } from '../deps.js';
import { errorMessage } from '../output.js';

/**
 * Wrap a command action: an exception prints `error: <message>` (plus any details) and sets
 * exit code 1 instead of a stack trace.
 */
export function run<A extends unknown[]>(
  deps: Pick<CliDeps, 'io'>,
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (err) {
      deps.io.err(`error: ${errorMessage(err)}`);
      const details = (err as { details?: unknown }).details;
      if (Array.isArray(details)) for (const d of details) deps.io.err(`  - ${String(d)}`);
      deps.io.setExitCode(1);
    }
  };
}
