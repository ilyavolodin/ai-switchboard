/**
 * Helpers shared by the source and executor screens: type icons, secret provider ids for
 * `secret://` references, the colours of per-type charts, and small form-value utilities.
 */
import type { InstanceSummary, StatusTone } from '@ai-switchboard/core/contract';

import type { IconName } from '../components/Icon.js';

/** The `<provider>` segment of a secret reference must be a plain id. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Provider ids for `secret://<provider>/<name>` inputs: the enabled secret-provider instances by
 * name (the core resolves through the instance named `<provider>`). `undefined` when none are
 * configured, so the input falls back to its defaults.
 */
export function secretProviderIds(instances: InstanceSummary[] | undefined): string[] | undefined {
  const ids = (instances ?? [])
    .filter((i) => i.enabled)
    .map((i) => (SEGMENT.test(i.name) ? i.name : i.typeId))
    .filter((id) => SEGMENT.test(id));
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique : undefined;
}

const TYPE_ICONS: Record<string, IconName> = {
  github: 'pr',
  linear: 'issue',
  datadog: 'alert',
  webhook: 'webhook',
  'poll-http': 'refresh',
  'claude-routines': 'run',
  'github-actions': 'play',
  http: 'link',
};

/** The icon for a plugin type (falls back to the area icon). */
export function typeIcon(typeId: string, kind: 'source' | 'executor'): IconName {
  return TYPE_ICONS[typeId] ?? (kind === 'source' ? 'sources' : 'executors');
}

/** Series colours for "by type" charts, in order. */
export const SERIES_COLORS = [
  'var(--primary)',
  'var(--sky)',
  'var(--teal)',
  'var(--berry)',
  'var(--sun)',
  'var(--border-4)',
] as const;

/** The colour for the i-th series. */
export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length] ?? 'var(--primary)';
}

/** The card border for a status: coral for errors, amber for warnings, dashed when disabled. */
export function cardTone(enabled: boolean, tone: StatusTone): 'error' | 'warn' | 'off' | null {
  if (!enabled) return 'off';
  if (tone === 'error' || tone === 'warn') return tone;
  return null;
}

/** "" → undefined, "12" → 12; anything that is not a finite number → undefined. */
export function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** Drops keys whose value is `undefined` so untouched caps are not sent. */
export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Stable deep comparison for form drafts (plain JSON values). */
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

/** "every 5 min", "every 45 s", "every 2 h". */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `every ${seconds} s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} min`;
  return `every ${Math.round(seconds / 360) / 10} h`;
}

/** A plain object, or `{}` for anything else (schema defaults of an object schema). */
export function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
