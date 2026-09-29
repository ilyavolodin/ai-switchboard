import type { UsageDimension, UsageReport } from '@ai-switchboard/sdk';

/** Undeclared keys and non-numeric values are dropped; the caller counts them against the plugin. */
export function sanitizeUsage(
  report: unknown,
  dimensions: readonly UsageDimension[],
): { usage: UsageReport | null; dropped: string[] } {
  if (report === undefined || report === null) return { usage: null, dropped: [] };
  if (typeof report !== 'object' || Array.isArray(report)) {
    return { usage: null, dropped: ['(not an object)'] };
  }
  const declared = new Set(dimensions.map((d) => d.id));
  const usage: UsageReport = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(report as Record<string, unknown>)) {
    if (!declared.has(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      dropped.push(key);
      continue;
    }
    usage[key] = value;
  }
  return { usage: Object.keys(usage).length > 0 ? usage : null, dropped };
}

export function mergeUsage(
  earlier: UsageReport | null,
  later: UsageReport | null,
  dimensions: readonly UsageDimension[],
): UsageReport | null {
  if (!earlier) return later;
  if (!later) return earlier;
  const out: UsageReport = { ...earlier };
  for (const [key, value] of Object.entries(later)) {
    const dim = dimensions.find((d) => d.id === key);
    const prev = out[key];
    // A tracking update reports the run's total so far, so later values replace earlier ones.
    out[key] = prev === undefined || dim?.aggregate !== 'max' ? value : Math.max(prev, value);
  }
  return out;
}
