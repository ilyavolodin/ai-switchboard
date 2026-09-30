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
