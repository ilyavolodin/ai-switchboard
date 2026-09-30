import type { PluginContext, Settings } from '@ai-switchboard/sdk';

import type { InstanceError } from '../../domain/instance-error.js';
import type { InstanceKind } from '../../domain/status.js';
import type { Telemetry } from '../../telemetry/telemetry.js';
import { errorText } from '../../util/errors.js';
import { guardActions } from '../actions.js';
import { attribute } from '../attribution.js';
import type { ContextTarget } from '../plugin-context.js';
import type { TypeRegistry } from '../type-registry.js';

import { createObject, KIND_SPECS } from './kind-specs.js';
import type { LiveByKind } from './live-set.js';
import type { InstanceRowHead } from './store.js';

export type BuildStage = 'plugin' | 'disabled' | 'secret' | 'create';

export type Instantiated<K extends InstanceKind> =
  | { ok: true; live: LiveByKind[K] }
  | { ok: false; stage: BuildStage; message: string; secretValues: string[] };

export interface BuilderDeps {
  registry: TypeRegistry;
  telemetry: Pick<Telemetry, 'childSpan'>;
  contextFor(target: ContextTarget): PluginContext;
  /** The plugin's declared network capability. */
  networkOf(pluginName: string): string[] | undefined;
  resolveSettings(
    settings: Record<string, unknown>,
  ): Promise<{ settings: Settings; secrets: string[] }>;
  onPluginError(
    pluginName: string,
    err: unknown,
    context: { instanceId: string; method: string },
  ): void;
}

export interface InstantiateOptions {
  /**
   * Wrap the object so exceptions count against the plugin, calls get spans and actions are
   * checked. Off for a preview: a half-typed draft is not the plugin's fault.
   */
  attributed: boolean;
}

/** Turns an instance row into a live object, the same way for every kind. */
export class InstanceBuilder {
  constructor(private readonly deps: BuilderDeps) {}

  async instantiate<K extends InstanceKind>(
    kind: K,
    row: InstanceRowHead,
    options: InstantiateOptions,
  ): Promise<Instantiated<K>> {
    const spec = KIND_SPECS[kind];
    const entry = this.deps.registry.get(kind, row.typeId);
    if (!entry)
      return { ok: false, stage: 'plugin', message: 'plugin_unavailable', secretValues: [] };
    if (!spec.buildsWhenDisabled && !row.enabled)
      return { ok: false, stage: 'disabled', message: 'disabled', secretValues: [] };

    let resolved: { settings: Settings; secrets: string[] } = {
      settings: row.settings,
      secrets: [],
    };
    if (spec.resolvesSecrets) {
      try {
        resolved = await this.deps.resolveSettings(row.settings);
      } catch (err) {
        return { ok: false, stage: 'secret', message: errorText(err), secretValues: [] };
      }
    }

    try {
      const ctx = this.deps.contextFor({
        instanceId: row.id,
        instanceName: row.name,
        pluginName: entry.pluginName,
        network: this.deps.networkOf(entry.pluginName),
        settings: row.settings,
        secretValues: resolved.secrets,
      });
      const created = createObject(entry.type, resolved.settings, ctx);
      const object = options.attributed
        ? guardActions(
            attribute(
              created,
              (err, method) => {
                this.deps.onPluginError(entry.pluginName, err, { instanceId: row.id, method });
              },
              {
                spans: {
                  telemetry: this.deps.telemetry,
                  kind,
                  plugin: entry.pluginName,
                  instanceId: row.id,
                },
              },
            ),
            spec.actions(entry.type),
          )
        : created;
      const live = spec.live({
        row,
        type: entry.type,
        pluginName: entry.pluginName,
        object,
        settings: resolved.settings,
        secrets: resolved.secrets,
      });
      return { ok: true, live };
    } catch (err) {
      if (options.attributed)
        this.deps.onPluginError(entry.pluginName, err, { instanceId: row.id, method: 'create' });
      return {
        ok: false,
        stage: 'create',
        message: errorText(err),
        secretValues: resolved.secrets,
      };
    }
  }
}

/** The instance error the runtime reports for a failed build. */
export function buildError(stage: BuildStage, message: string): InstanceError {
  switch (stage) {
    case 'plugin':
      return { code: 'plugin_unavailable', message: '' };
    case 'disabled':
      return DISABLED;
    case 'secret':
      return { code: 'secret_error', message };
    case 'create':
      return { code: 'create_failed', message };
  }
}

export const DISABLED: InstanceError = { code: 'disabled', message: '' };
