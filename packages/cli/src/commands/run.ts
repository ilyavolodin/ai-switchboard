import { errorText, isRecord } from '@ai-switchboard/sdk/json';

import type { CliDeps } from '../deps.js';

/** An exception prints `error: <message>` and sets exit code 1 instead of a stack trace. */
export function run<A extends unknown[]>(
  deps: Pick<CliDeps, 'io'>,
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (err) {
      deps.io.err(`error: ${errorText(err)}`);
      const details = isRecord(err) ? err.details : undefined;
      if (Array.isArray(details)) for (const d of details) deps.io.err(`  - ${String(d)}`);
      deps.io.setExitCode(1);
    }
  };
}
