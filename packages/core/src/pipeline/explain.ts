import type { ProcessDocument, Trigger } from '../domain/process.js';
import type { DispatchOutcome, EventStage, MatchSkip } from '../domain/status.js';

import { candidateTriggers, skippedTriggers } from './match.js';

/**
 * "Why nothing ran": for one event, which processes with a trigger on its source took it and,
 * for each that did not, the reason. Pure: the caller passes the event's recorded match
 * decisions and dispatches plus the processes as they are now. Recorded decisions win; a process
 * with nothing recorded (an event matched before skips were recorded, or a trigger added since)
 * is explained from the current configuration and marked `basis: 'now'`.
 */

export interface ExplainDecision {
  processId: string;
  triggerId: string;
  expr?: string;
  result: boolean;
  error?: string;
  skip?: MatchSkip;
}

export interface ExplainProcess {
  id: string;
  name: string;
  enabled: boolean;
  document: ProcessDocument;
  createdAt: Date;
}

export interface ExplainInput {
  event: {
    sourceId: string;
    type: string;
    stage: EventStage;
    stageReason: string | null;
    receivedAt: Date;
  };
  decisions: readonly ExplainDecision[];
  dispatches: readonly { processId: string; outcome: DispatchOutcome }[];
  processes: readonly ExplainProcess[];
}

export type ExplanationTone = 'ok' | 'warn' | 'off';

export interface Explanation {
  processId: string;
  processName: string;
  taken: boolean;
  reason: string;
  /** `recorded` = what was true when the event arrived; `now` = the current configuration. */
  basis: 'recorded' | 'now';
  tone: ExplanationTone;
}

function triggerName(t: Trigger | undefined, id: string): string {
  const label = t?.describe.trim();
  return `trigger "${label !== undefined && label !== '' ? label : id}"`;
}

interface Reason {
  text: string;
  tone: ExplanationTone;
}

function decisionReason(
  d: ExplainDecision,
  doc: ProcessDocument | undefined,
  eventType: string,
): Reason {
  const t = doc?.triggers.find((x) => x.id === d.triggerId);
  switch (d.skip) {
    case 'process_disabled':
      return { text: 'process is disabled', tone: 'warn' };
    case 'trigger_disabled':
      return { text: `${triggerName(t, d.triggerId)} is disabled`, tone: 'warn' };
    case 'type_not_subscribed':
      return {
        text: `event type ${eventType} is not in ${triggerName(t, d.triggerId)}${
          t ? ` (subscribes to ${t.eventTypes.join(', ') || 'nothing'})` : ''
        }`,
        tone: 'off',
      };
    case undefined:
      if (d.error !== undefined) return { text: `filter error: ${d.error}`, tone: 'warn' };
      return { text: `filter false: ${d.expr ?? '(no filter)'}`, tone: 'off' };
  }
}

/** Door stages stop an event before match; every process on the source shares the reason. */
function doorReason(stage: EventStage, type: string, stageReason: string | null): Reason | null {
  const suffix = stageReason ? ` (${stageReason})` : '';
  switch (stage) {
    case 'source_disabled':
      return { text: 'source is disabled', tone: 'off' };
    case 'type_muted':
      return { text: `type ${type} is muted on the source`, tone: 'off' };
    case 'event_invalid':
      return { text: `event invalid: ${stageReason ?? 'failed validation'}`, tone: 'warn' };
    case 'source_throttled':
      return { text: `source throttled${suffix}`, tone: 'warn' };
    case 'received':
    case 'matched':
    case 'unmatched':
      return null;
  }
}

// Worst first, so a process with several triggers leads with the most actionable reason.
const TONE_RANK: Record<ExplanationTone, number> = { warn: 0, off: 1, ok: 2 };

function fold(reasons: Reason[]): Reason {
  const unique = [...new Map(reasons.map((r) => [r.text, r])).values()].sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone],
  );
  return {
    text: unique.map((r) => r.text).join('; '),
    tone: unique[0]?.tone ?? 'off',
  };
}

export function explainEvent(input: ExplainInput): Explanation[] {
  const { event } = input;
  if (event.stage === 'received') return [];
  // Processes created after the event could not have taken it; leave them out.
  const existing = input.processes.filter((p) => p.createdAt <= event.receivedAt);
  const byId = new Map(input.processes.map((p) => [p.id, p]));
  const onSource = existing.filter((p) =>
    p.document.triggers.some((t) => t.sourceId === event.sourceId),
  );
  const out: Explanation[] = [];

  const door = doorReason(event.stage, event.type, event.stageReason);
  if (door) {
    for (const p of onSource) {
      out.push({
        processId: p.id,
        processName: p.name,
        taken: false,
        reason: door.text,
        basis: 'recorded',
        tone: door.tone,
      });
    }
    return out;
  }

  const recorded = new Map<string, ExplainDecision[]>();
  for (const d of input.decisions) {
    const list = recorded.get(d.processId) ?? [];
    list.push(d);
    recorded.set(d.processId, list);
  }
  for (const [processId, list] of recorded) {
    const proc = byId.get(processId);
    const name = proc?.name ?? '(deleted process)';
    const hit = list.find((d) => d.result);
    if (hit) {
      const deduped = input.dispatches.some(
        (d) => d.processId === processId && d.outcome === 'deduped',
      );
      const t = proc?.document.triggers.find((x) => x.id === hit.triggerId);
      out.push({
        processId,
        processName: name,
        taken: true,
        reason: deduped
          ? `${triggerName(t, hit.triggerId)} matched, but it was deduped (already dispatched in the last 7 days)`
          : `${triggerName(t, hit.triggerId)} matched`,
        basis: 'recorded',
        tone: deduped ? 'off' : 'ok',
      });
      continue;
    }
    const disabled = list.find((d) => d.skip === 'process_disabled');
    const r = disabled
      ? decisionReason(disabled, proc?.document, event.type)
      : fold(list.map((d) => decisionReason(d, proc?.document, event.type)));
    out.push({
      processId,
      processName: name,
      taken: false,
      reason: r.text,
      basis: 'recorded',
      tone: r.tone,
    });
  }

  // Nothing recorded for this process: explain it from the configuration as it is now.
  for (const p of onSource) {
    if (recorded.has(p.id)) continue;
    const matchable = [{ id: p.id, enabled: p.enabled, document: p.document }];
    const skips = skippedTriggers(event, matchable);
    const candidates = candidateTriggers(event, matchable);
    const reasons: Reason[] = skips.map((k) =>
      decisionReason({ ...k, result: false }, p.document, event.type),
    );
    if (candidates.length > 0)
      reasons.push({
        text: 'no decision was recorded; its triggers changed after the event arrived',
        tone: 'off',
      });
    const r = skips.some((k) => k.skip === 'process_disabled')
      ? { text: 'process is disabled', tone: 'warn' as const }
      : fold(reasons);
    out.push({
      processId: p.id,
      processName: p.name,
      taken: false,
      reason: r.text,
      basis: 'now',
      tone: r.tone,
    });
  }
  return out.sort(
    (a, b) => Number(b.taken) - Number(a.taken) || a.processName.localeCompare(b.processName),
  );
}

/**
 * One line for the Activity row of an event nothing took: the most actionable process reason,
 * or that no process listens to the source. Null when something took it, while it waits for
 * match, and at door stages (the stage label already says why).
 */
export function summarizeWhy(
  stage: EventStage,
  explanations: readonly Explanation[],
): string | null {
  if (stage !== 'unmatched' || explanations.some((x) => x.taken)) return null;
  const sorted = [...explanations].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const first = sorted[0];
  if (!first) return 'no process has a trigger on this source';
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '';
  return `${first.processName}: ${first.reason}${more}`;
}
