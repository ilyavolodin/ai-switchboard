import { join, resolve } from 'node:path';

/** The npm project admins install plugins into. */
export function pluginsDir(home: string): string {
  return join(resolve(home), 'plugins');
}

/** Where discovery finds installed plugins. */
export function installedModulesDir(home: string): string {
  return join(pluginsDir(home), 'node_modules');
}

export function lockfilePath(home: string): string {
  return join(resolve(home), 'plugins.lock.json');
}
