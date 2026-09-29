/** A process's destination target over the destination instance's target defaults. */
export function effectiveTarget(target: unknown, defaults: Record<string, unknown>): unknown {
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    return { ...defaults, ...(target as Record<string, unknown>) };
  }
  return target ?? defaults;
}
