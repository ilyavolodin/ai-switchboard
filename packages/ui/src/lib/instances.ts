import type { InstanceSummary, StatusTone } from '@ai-switchboard/core/contract';

/** The `<provider>` segment of a secret reference must be a plain id. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * The core resolves `secret://<provider>/…` through the instance named `<provider>`. `undefined`
 * while the list is still loading.
 */
export function secretProviderIds(instances: InstanceSummary[] | undefined): string[] | undefined {
  if (instances === undefined) return undefined;
  const ids = instances
    .filter((i) => i.enabled)
    .map((i) => (SEGMENT.test(i.name) ? i.name : i.typeId))
    .filter((id) => SEGMENT.test(id));
  return [...new Set(ids)];
}

/** By name, or by type for an instance whose name is not a plain id. */
export function instanceForProvider(
  provider: string,
  instances: InstanceSummary[] | undefined,
): InstanceSummary | undefined {
  return (
    instances?.find((i) => i.name === provider) ??
    instances?.find((i) => !SEGMENT.test(i.name) && i.typeId === provider)
  );
}

export const SERIES_COLORS = [
  'var(--primary)',
  'var(--sky)',
  'var(--teal)',
  'var(--berry)',
  'var(--sun)',
  'var(--border-4)',
] as const;

export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length] ?? 'var(--primary)';
}

export function cardTone(enabled: boolean, tone: StatusTone): 'error' | 'warn' | 'off' | null {
  if (!enabled) return 'off';
  if (tone === 'error' || tone === 'warn') return tone;
  return null;
}

export function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** So untouched caps are not sent. */
export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

export function formatInterval(seconds: number): string {
  if (seconds < 60) return `every ${seconds} s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} min`;
  return `every ${Math.round(seconds / 360) / 10} h`;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
