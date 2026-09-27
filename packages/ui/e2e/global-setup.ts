/**
 * Starts the real stack once for the whole run (Postgres in Docker, the stub, the built core
 * serving the built UI), seeds it through the API and hands the ids to the tests through
 * `process.env.E2E_STATE`. The returned function is the teardown.
 *
 * Needs `pnpm build` first (the `test:e2e` script runs it) and a running Docker daemon. When
 * `E2E_STATE` is already set (a stack you started and seeded yourself), it is used as is.
 */
import { seed } from './seed.js';
import { startStack } from './stack.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_STATE !== undefined) return () => Promise.resolve();
  const stack = await startStack();
  try {
    const state = await seed(stack.baseUrl, stack.stubUrl);
    process.env.E2E_STATE = JSON.stringify(state);
  } catch (err) {
    await stack.stop();
    throw err;
  }
  return () => stack.stop();
}
