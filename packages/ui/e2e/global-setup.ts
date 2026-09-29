// Needs `pnpm build` and Docker. A preset `E2E_STATE` (a stack you seeded yourself) is used as is.
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
