import type { OidcClient } from '../auth/oidc.js';
import type { Deps } from '../deps.js';
import type { PluginHost } from '../plugins/host.js';
import type { RegistryFetch } from '../plugins/search.js';
import type { PipelinePort, PreviewPort } from './pipeline-port.js';

/** Everything route handlers use. */
export interface ApiContext extends Deps {
  host: PluginHost;
  pipeline: PipelinePort;
  preview: PreviewPort;
  oidc: OidcClient | undefined;
  /** `npm` runner for plugin installs from the UI (injectable for tests). */
  runNpm?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  /** `fetch` for npm registry searches (injectable for tests). */
  registryFetch?: RegistryFetch;
}
