import { eq } from 'drizzle-orm';

import type { InspectPluginResponse } from '../api/contract.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { plugins } from '../db/schema.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';
import {
  inspectPlugin,
  isPluginInstallError,
  listInstalled,
  removePlugin,
  type RunNpm,
} from '../plugins/install.js';
import { isPluginNameKind, PLUGIN_NAME_KINDS } from '../plugins/naming.js';
import {
  isRegistryUnavailableError,
  searchRegistry,
  type RegistryFetch,
  type RegistryPackage,
} from '../plugins/search.js';
import { auditChange, type ChangeMeta } from './audit.js';
import { badRequest, notFound, ServiceError, unprocessable } from './errors.js';

export interface PluginAdminDeps {
  db: Db;
  config: Pick<CoreConfig, 'home' | 'npmRegistry'>;
  host: PluginAdminPort;
  runNpm?: RunNpm | undefined;
  registryFetch?: RegistryFetch | undefined;
}

const SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** An npm package name plus an optional version range, as `npm install` takes it. */
export function packageSpec(pkg: string, range?: string): string {
  if (!SPEC.test(pkg))
    throw badRequest('Give an npm package name such as @acme/switchboard-source-jira.');
  if (range !== undefined && range !== '' && !/^[\w.^~<>=*|\s-]+$/.test(range))
    throw badRequest('That version range is not valid.');
  return range ? `${pkg}@${range}` : pkg;
}

const installRefusal = (err: unknown): never => {
  if (isPluginInstallError(err)) throw unprocessable(err.message);
  throw err;
};

const runNpmOf = (deps: PluginAdminDeps) => (deps.runNpm ? { runNpm: deps.runNpm } : {});

export async function inspectPackage(
  deps: PluginAdminDeps,
  spec: string,
): Promise<InspectPluginResponse> {
  const result = await inspectPlugin({ spec, ...runNpmOf(deps) }).catch(installRefusal);
  return {
    package: result.name,
    version: result.version,
    sdkRange: result.sdkRange,
    compatible: result.compatible,
    capabilities: result.capabilities ?? {},
    types: result.plugin?.types ?? [],
    integrity: result.integrity,
  };
}

export interface InstalledOutcome {
  name: string;
  pendingRestart: boolean;
  /** Install warnings and the load message, shown when the plugin did not load. */
  warnings: string[];
  loaded: boolean;
}

/** Installs and loads a package on this replica; the others pick it up on their sync pass. */
export async function installPackage(
  deps: PluginAdminDeps,
  spec: string,
  meta: ChangeMeta,
): Promise<InstalledOutcome> {
  const { install, plugin, pendingRestart } = await deps.host
    .installAndLoad(spec, deps.runNpm)
    .catch(installRefusal);
  const loaded = plugin.status === 'loaded' && !pendingRestart;
  await auditChange(deps.db, meta, {
    scope: 'plugin',
    targetId: install.name,
    field: 'installed',
    after: {
      spec,
      version: install.version,
      integrity: install.integrity,
      capabilities: install.capabilities ?? null,
      loaded,
    },
  });
  return {
    name: install.name,
    pendingRestart,
    warnings: [...install.warnings, ...(plugin.message ? [plugin.message] : [])],
    loaded: plugin.status === 'loaded',
  };
}

/**
 * Removes an installed plugin. Its row stays as the tombstone every replica's sync pass acts on
 * (each removes its own copy); this replica unregisters it now.
 */
export async function uninstallPackage(
  deps: PluginAdminDeps,
  name: string,
  meta: ChangeMeta,
): Promise<void> {
  const [row] = await deps.db.select().from(plugins).where(eq(plugins.name, name));
  const installed = (await listInstalled(deps.config.home)).find((l) => l.name === name);
  if (!installed && !row?.installSpec) {
    if (row?.origin === 'baked')
      throw unprocessable(`${name} is baked into the image; rebuild without it to remove it.`);
    throw notFound('Installed plugin');
  }
  if (installed) {
    await removePlugin({ home: deps.config.home, name, ...runNpmOf(deps) }).catch(installRefusal);
  }
  await deps.host.forgetInstall(name);
  await auditChange(deps.db, meta, {
    scope: 'plugin',
    targetId: name,
    field: 'removed',
    before: { version: installed?.version ?? row?.installVersion ?? row?.version ?? null },
  });
}

/** Plugin packages on the registry; a 503 when it cannot be reached. */
export async function searchPackages(
  deps: PluginAdminDeps,
  kind: string | undefined,
  q: string | undefined,
): Promise<RegistryPackage[]> {
  if (kind !== undefined && kind !== '' && !isPluginNameKind(kind))
    throw badRequest(`kind must be one of ${PLUGIN_NAME_KINDS.join(', ')}.`);
  try {
    return await searchRegistry({
      registry: deps.config.npmRegistry,
      ...(isPluginNameKind(kind) ? { kind } : {}),
      q: (q ?? '').trim().slice(0, 100),
      ...(deps.registryFetch ? { fetch: deps.registryFetch } : {}),
    });
  } catch (err) {
    if (isRegistryUnavailableError(err))
      throw new ServiceError(
        503,
        'registry_unavailable',
        `${err.message} Search needs the registry; install by name with Add plugin, or bake plugins into the image for offline installs.`,
      );
    throw err;
  }
}
