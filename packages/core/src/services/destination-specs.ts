import type { MeterSpec, UsageDimension } from '@ai-switchboard/sdk';

import type { PluginRuntime } from '../plugins/runtime.js';

export interface DestinationSpecs {
  usage: UsageDimension[];
  meters: MeterSpec[];
}

/**
 * The usage dimensions and meters of a destination instance: from its live object, else what the
 * type declares for these settings (`usageFor` / `metersFor`), as the host builds it. Empty
 * without the plugin.
 */
export function destinationSpecs(
  runtime: PluginRuntime,
  destination: { id: string; typeId: string; settings: Record<string, unknown> },
): DestinationSpecs {
  const live = runtime.destination(destination.id);
  if (live) return { usage: live.usage, meters: live.meters };
  const type = runtime.destinationType(destination.typeId)?.type;
  if (!type) return { usage: [], meters: [] };
  return {
    usage: perInstance(() => type.usageFor?.(destination.settings), type.usage),
    meters: perInstance(() => type.metersFor?.(destination.settings), type.meters ?? []),
  };
}

/** A per-instance declaration that throws on these (unresolved) settings falls back to the type's. */
function perInstance<T>(declare: () => T[] | undefined, fallback: T[]): T[] {
  try {
    return declare() ?? fallback;
  } catch {
    return fallback;
  }
}
