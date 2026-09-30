import type { StatusTone } from '@ai-switchboard/core/contract';

export { SERIES_COLORS, seriesColor } from './colors.js';
export { instanceForProvider, secretProviderIds } from './secretProviders.js';
export { asRecord, parseNumber, sameValue, withoutUndefined } from './values.js';

export function cardTone(enabled: boolean, tone: StatusTone): 'error' | 'warn' | 'off' | null {
  if (!enabled) return 'off';
  if (tone === 'error' || tone === 'warn') return tone;
  return null;
}

export function formatInterval(seconds: number): string {
  if (seconds < 60) return `every ${seconds} s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} min`;
  return `every ${Math.round(seconds / 360) / 10} h`;
}
