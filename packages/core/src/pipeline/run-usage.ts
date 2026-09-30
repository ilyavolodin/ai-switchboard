import type { UsageDimension, UsageReport } from '@ai-switchboard/sdk';

import { mergeUsage, sanitizeUsage } from './usage.js';

/**
 * A reported usage merged into what the run already has. `dropped` lists the keys that were not
 * declared (or not numbers); the caller counts them against the plugin.
 */
export function mergeRunUsage(
  previous: UsageReport | null,
  report: unknown,
  dimensions: readonly UsageDimension[],
): { usage: UsageReport | null; dropped: string[] } {
  if (report === undefined) return { usage: previous, dropped: [] };
  const clean = sanitizeUsage(report, dimensions);
  return { usage: mergeUsage(previous, clean.usage, dimensions), dropped: clean.dropped };
}
