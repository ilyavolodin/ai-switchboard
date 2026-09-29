import type { ProcessDocument } from '../domain/process.js';
import type { MatchSkip } from '../domain/status.js';

/** Filters are evaluated by the caller (they may call `$resolve`), not here. */

export interface MatchableProcess {
  id: string;
  enabled: boolean;
  document: ProcessDocument;
}

export interface TriggerCandidate {
  processId: string;
  triggerId: string;
  filter?: string;
}

/** `github.pr.labeled` matches itself, `github.pr.*` and `*`. */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
  return false;
}

export function candidateTriggers(
  event: { sourceId: string; type: string },
  processes: readonly MatchableProcess[],
): TriggerCandidate[] {
  const out: TriggerCandidate[] = [];
  for (const p of processes) {
    // The `processes.enabled` column is authoritative (the document's flag mirrors it).
    if (!p.enabled) continue;
    for (const t of p.document.triggers) {
      if (!t.enabled || t.sourceId !== event.sourceId) continue;
      if (!t.eventTypes.some((pattern) => eventTypeMatches(pattern, event.type))) continue;
      out.push({
        processId: p.id,
        triggerId: t.id,
        ...(t.filter !== undefined ? { filter: t.filter } : {}),
      });
    }
  }
  return out;
}

export interface SkippedTrigger {
  processId: string;
  triggerId: string;
  skip: MatchSkip;
}

/**
 * Recorded so an unmatched event can say what was true when it arrived. A disabled process
 * yields one entry (its first trigger on the source).
 */
export function skippedTriggers(
  event: { sourceId: string; type: string },
  processes: readonly MatchableProcess[],
): SkippedTrigger[] {
  const out: SkippedTrigger[] = [];
  for (const p of processes) {
    const onSource = p.document.triggers.filter((t) => t.sourceId === event.sourceId);
    const first = onSource[0];
    if (!first) continue;
    if (!p.enabled) {
      out.push({ processId: p.id, triggerId: first.id, skip: 'process_disabled' });
      continue;
    }
    for (const t of onSource) {
      if (!t.enabled) out.push({ processId: p.id, triggerId: t.id, skip: 'trigger_disabled' });
      else if (!t.eventTypes.some((pattern) => eventTypeMatches(pattern, event.type)))
        out.push({ processId: p.id, triggerId: t.id, skip: 'type_not_subscribed' });
    }
  }
  return out;
}

export interface FilterEvaluation extends TriggerCandidate {
  result: boolean;
  error?: string;
}

export type ProcessMatchOutcome = 'matched' | 'filter_error' | 'filtered';

export interface ProcessMatch {
  processId: string;
  triggerId: string;
  outcome: ProcessMatchOutcome;
  filter?: string;
  error?: string;
}

/** Any true filter wins, so overlapping triggers converge on one dispatch. */
export function decideMatches(evaluations: readonly FilterEvaluation[]): ProcessMatch[] {
  const byProcess = new Map<string, FilterEvaluation[]>();
  for (const e of evaluations) {
    const list = byProcess.get(e.processId) ?? [];
    list.push(e);
    byProcess.set(e.processId, list);
  }
  const out: ProcessMatch[] = [];
  for (const [processId, list] of byProcess) {
    const hit = list.find((e) => e.result);
    const errored = list.find((e) => e.error !== undefined);
    const chosen = hit ?? errored ?? list[0];
    if (!chosen) continue;
    out.push({
      processId,
      triggerId: chosen.triggerId,
      outcome: hit ? 'matched' : errored ? 'filter_error' : 'filtered',
      ...(chosen.filter !== undefined ? { filter: chosen.filter } : {}),
      ...(!hit && errored?.error !== undefined ? { error: errored.error } : {}),
    });
  }
  return out;
}

export function eventStageAfterMatch(matches: readonly ProcessMatch[]): 'matched' | 'unmatched' {
  return matches.some((m) => m.outcome === 'matched') ? 'matched' : 'unmatched';
}
