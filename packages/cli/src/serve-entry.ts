import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_PACKAGE = '@ai-switchboard/core';

async function packageName(dir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find `@ai-switchboard/core`'s package root from any resolved module URL inside it and return
 * its built server entry, `<root>/dist/main.js`. Works from source (the `@ai-switchboard/source`
 * condition resolves to `src/index.ts`), from an installed package and in the image.
 */
export async function resolveServerEntry(resolvedUrl: string): Promise<string> {
  let dir = dirname(fileURLToPath(resolvedUrl));
  while ((await packageName(dir)) !== CORE_PACKAGE) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find the ${CORE_PACKAGE} package root`);
    dir = parent;
  }
  const entry = join(dir, 'dist', 'main.js');
  try {
    await access(entry);
  } catch {
    throw new Error(`${entry} does not exist; build the core first (pnpm build)`);
  }
  return entry;
}
