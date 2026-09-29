import type { OidcClient } from '../auth/oidc.js';
import type { Deps } from '../deps.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';
import type { RunNpm } from '../plugins/install.js';
import type { RegistryFetch } from '../plugins/search.js';
import type { PipelinePort, PreviewPort } from './pipeline-port.js';

export interface ApiContext extends Deps {
  host: PluginAdminPort;
  pipeline: PipelinePort;
  preview: PreviewPort;
  oidc: OidcClient | undefined;
  /** `npm` runner for plugin installs from the UI (injectable for tests). */
  runNpm?: RunNpm;
  /** `fetch` for npm registry searches (injectable for tests). */
  registryFetch?: RegistryFetch;
}

export interface ApiContextParts {
  deps: Deps;
  host: PluginAdminPort;
  pipeline: PipelinePort;
  preview: PreviewPort;
  oidc: OidcClient | undefined;
  runNpm?: RunNpm | undefined;
  registryFetch?: RegistryFetch | undefined;
}

/** The one place an `ApiContext` is assembled (the server and the API test harness). */
export function buildApiContext(parts: ApiContextParts): ApiContext {
  return {
    ...parts.deps,
    host: parts.host,
    pipeline: parts.pipeline,
    preview: parts.preview,
    oidc: parts.oidc,
    ...(parts.runNpm ? { runNpm: parts.runNpm } : {}),
    ...(parts.registryFetch ? { registryFetch: parts.registryFetch } : {}),
  };
}
