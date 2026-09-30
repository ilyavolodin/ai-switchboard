import { readFileSync } from 'node:fs';

import { asString, parseJsonObject } from '@ai-switchboard/sdk/json';

/** `src/` and `dist/` both sit one level below the package root. */
function packageVersion(): string {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return asString(parseJsonObject(text)?.version) ?? '0.0.0';
}

/** The CLI and the core release together, so this is also the core version. */
export const CLI_VERSION = packageVersion();
