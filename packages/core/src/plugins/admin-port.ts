import type { InstanceKind } from '../domain/status.js';

import type { InstallResult, RunNpm } from './install.js';
import type { HotLoadResult } from './install-sync.js';
import type { LiveSecretProvider, LiveSource } from './runtime.js';

export type PreviewSourceResult =
  | { ok: true; live: LiveSource }
  | { ok: false; stage: 'plugin' | 'secret' | 'create'; message: string; secretValues: string[] };

/** What the API may ask of the plugin host beyond `PluginRuntime`. */
export interface PluginAdminPort {
  /** Prefer `PluginRuntime.reload`; kept here while routes move over. */
  reload(kind: InstanceKind, id: string): Promise<void>;
  reloadDependentsOf(
    providerNames: string | readonly string[],
  ): Promise<{ kind: Exclude<InstanceKind, 'secret_provider'>; id: string; name: string }[]>;
  instantiateAll(): Promise<void>;
  installAndLoad(
    spec: string,
    runNpm?: RunNpm,
  ): Promise<{ install: InstallResult } & HotLoadResult>;
  forgetInstall(name: string): Promise<void>;
  secretProvider(id: string): LiveSecretProvider | undefined;
  /**
   * For the sample-delivery preview: nothing is registered, stored, or counted against the plugin.
   * `secretValues` lets the caller redact output.
   */
  buildPreviewSource(
    typeId: string,
    settings: Record<string, unknown>,
    instanceId: string,
    name: string,
  ): Promise<PreviewSourceResult>;
}
