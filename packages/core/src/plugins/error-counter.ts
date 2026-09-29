import type { CoreLogger } from '../logger.js';
import type { Telemetry } from '../telemetry/telemetry.js';

import type { PluginErrorCounts } from './catalog-store.js';

export type PluginErrorKind = keyof PluginErrorCounts;

export interface PluginErrorContext {
  instanceId?: string;
  method?: string;
}

/**
 * The one path a plugin error takes: one `switchboard.plugin.errors` decision (metric and log
 * line), and a count added to the plugin's row shortly after, batched per plugin.
 */
export class PluginErrorCounter {
  private readonly queue = new Map<string, PluginErrorCounts>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      telemetry: Pick<Telemetry, 'decision'>;
      logger: CoreLogger;
      persist: (pluginName: string, counts: PluginErrorCounts) => Promise<void>;
      flushDelayMs?: number;
    },
  ) {}

  record(
    pluginName: string,
    kind: PluginErrorKind,
    detail?: string,
    context: PluginErrorContext = {},
  ): void {
    this.deps.telemetry.decision(
      'switchboard.plugin.errors',
      { plugin: pluginName, kind },
      { detail, instance_id: context.instanceId, method: context.method },
    );
    const counts = this.queue.get(pluginName) ?? {
      exception: 0,
      invalid_event: 0,
      invalid_usage: 0,
    };
    counts[kind]++;
    this.queue.set(pluginName, counts);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.deps.flushDelayMs ?? 250);
  }

  async flush(): Promise<void> {
    const pending = [...this.queue.entries()];
    this.queue.clear();
    for (const [name, counts] of pending) {
      try {
        await this.deps.persist(name, counts);
      } catch (err) {
        this.deps.logger.error({ err, plugin: name }, 'could not record plugin errors');
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
