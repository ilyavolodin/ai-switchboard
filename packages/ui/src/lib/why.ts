/** "Why nothing ran": explanations from an event detail or a trace, in one shape for the UI. */
import type { EventExplanation, StatusTone, TraceEntry } from '@ai-switchboard/core/contract';

export interface WhyItem {
  /** Absent for "no process has a trigger on this source". */
  processId?: string;
  processName?: string;
  reason: string;
  tone: StatusTone;
  /** `now`: explained from the current configuration, not recorded when the event arrived. */
  basis: 'recorded' | 'now';
}

/** When some process took the event, the rest "did not take it"; otherwise nothing ran. */
export function whyTitle(processesThatTookIt: number): string {
  return processesThatTookIt === 0 ? 'Why nothing ran' : 'Processes that did not take it';
}

export function whyFromExplanations(list: readonly EventExplanation[]): WhyItem[] {
  return list
    .filter((x) => !x.taken)
    .map((x) => ({
      processId: x.processId,
      processName: x.processName,
      reason: x.reason,
      tone: x.tone,
      basis: x.basis,
    }));
}

export function isWhyEntry(e: TraceEntry): boolean {
  return e.kind === 'filter' && (e.data?.taken === false || e.title.startsWith('Nothing ran:'));
}

export function whyFromTrace(entries: readonly TraceEntry[]): WhyItem[] {
  const seen = new Set<string>();
  const out: WhyItem[] = [];
  for (const e of entries) {
    if (!isWhyEntry(e)) continue;
    const key = `${e.eventId ?? ''}:${e.processId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason =
      typeof e.data?.reason === 'string' ? e.data.reason : e.title.replace(/^Nothing ran: /, '');
    out.push({
      ...(e.processId ? { processId: e.processId } : {}),
      ...(e.processName ? { processName: e.processName } : {}),
      reason,
      tone: e.tone,
      basis: e.data?.basis === 'now' ? 'now' : 'recorded',
    });
  }
  return out;
}
