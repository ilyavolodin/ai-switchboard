import type { MeterGaugeDTO } from '@ai-switchboard/core/contract';

import { formatDuration, formatRelative, toMs } from './format.js';
import { meterFraction } from './gauge.js';

/** "5-hour window" → "5 h", "weekly window" → "7 d", "API rate limit" → "API". */
export function shortMeterLabel(title: string): string {
  const t = title.toLowerCase();
  const hours = /(\d+)[\s-]*(hour|h)\b/.exec(t);
  if (hours) return `${hours[1] ?? ''} h`;
  const daysMatch = /(\d+)[\s-]*(day|d)\b/.exec(t);
  if (daysMatch) return `${daysMatch[1] ?? ''} d`;
  if (t.includes('week')) return '7 d';
  if (t.includes('month')) return '30 d';
  if (t.includes('api')) return 'API';
  if (t.includes('run')) return 'runs';
  if (t.includes('spend') || t.includes('$')) return 'spend';
  return title.split(/\s+/)[0] ?? title;
}

/** "62%" for windows; "14/22" for allowances with used/limit; "—" when never read. */
export function meterValueText(
  m: Pick<MeterGaugeDTO, 'kind' | 'utilization' | 'used' | 'limit'>,
): string {
  if (m.kind === 'allowance' && m.used != null && m.limit != null) {
    return `${formatNumber(m.used)}/${formatNumber(m.limit)}`;
  }
  const f = meterFraction(m);
  return f == null ? '—' : `${Math.round(f * 100)}%`;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The one that throttles event runs first. */
export function lowestEventCeiling(m: Pick<MeterGaugeDTO, 'ceilings'>): number | null {
  if (m.ceilings.length === 0) return null;
  return Math.min(...m.ceilings.map((c) => c.events));
}

/** One per destination; falls back to each destination's first meter. */
export function primaryMeters(meters: MeterGaugeDTO[]): MeterGaugeDTO[] {
  const byDestination = new Map<string, MeterGaugeDTO[]>();
  for (const m of meters) {
    const list = byDestination.get(m.destinationId) ?? [];
    list.push(m);
    byDestination.set(m.destinationId, list);
  }
  const out: MeterGaugeDTO[] = [];
  for (const list of byDestination.values()) {
    const primary = list.find((m) => m.primary) ?? list[0];
    if (primary) out.push(primary);
  }
  return out;
}

/** `resets` is `null` once the reset has passed. */
export function meterTimes(
  m: Pick<MeterGaugeDTO, 'observedAt' | 'resetsAt'>,
  nowMs: number,
): { lastRead: string; resets: string | null } {
  const observed = toMs(m.observedAt);
  const reset = toMs(m.resetsAt);
  return {
    lastRead: observed != null ? `last read ${formatRelative(observed, nowMs)}` : 'never read',
    resets: reset != null && reset > nowMs ? `resets in ${formatDuration(reset - nowMs)}` : null,
  };
}
