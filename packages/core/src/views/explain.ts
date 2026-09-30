import type { ProcessDocument, Trigger } from '../domain/process.js';
import {
  toneRank,
  type DispatchOutcome,
  type EventStage,
  type ExplanationTone,
  type MatchSkip,
} from '../domain/status.js';
import { DEDUPE_WINDOW_DAYS } from '../pipeline/dedupe.js';
import { candidateTriggers, skippedTriggers } from '../pipeline/match.js';
import { groupBy } from '../util/collections.js';

/**
 * "Why nothing ran" for one event. Recorded decisions win; a process with nothing recorded (an
 * event matched before skips were recorded, or a trigger added since) is explained from the
 * current configuration and marked `basis: 'now'`.
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

export interface Explanation {
  processId: string;
  processName: string;
  taken: boolean;
  reason: string;
  /** `recorded` = what was true when the event arrived; `now` = the current configuration. */
  basis: 'recorded' | 'now';
  tone: ExplanationTone;
}

interface Reason {
  text: string;
  tone: ExplanationTone;
}

const PROCESS_DISABLED: Reason = { text: 'process is disabled', tone: 'warn' };

function triggerName(t: Trigger | undefined, id: string): string {
  const label = t?.describe.trim();
  return `trigger "${label !== undefined && label !== '' ? label : id}"`;
}

function decisionReason(
  d: Omit<ExplainDecision, 'processId'>,
  doc: ProcessDocument | undefined,
  eventType: string,
): Reason {
  const t = doc?.triggers.find((x) => x.id === d.triggerId);
  switch (d.skip) {
    case 'process_disabled':
      return PROCESS_DISABLED;
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

const byTone = (a: { tone: ExplanationTone }, b: { tone: ExplanationTone }) =>
  toneRank(a.tone) - toneRank(b.tone);

/** Worst first, so a process with several triggers leads with the most actionable reason. */
function fold(reasons: Reason[]): Reason {
  const unique = [...new Map(reasons.map((r) => [r.text, r])).values()].sort(byTone);
  return { text: unique.map((r) => r.text).join('; '), tone: unique[0]?.tone ?? 'off' };
}

/** A disabled process is explained by that alone, whatever its triggers say. */
function processReason(skips: readonly { skip?: MatchSkip }[], others: () => Reason[]): Reason {
  return skips.some((k) => k.skip === 'process_disabled') ? PROCESS_DISABLED : fold(others());
}

function explanation(
  p: { id: string; name: string },
  taken: boolean,
  r: Reason,
  basis: Explanation['basis'],
): Explanation {
  return { processId: p.id, processName: p.name, taken, reason: r.text, basis, tone: r.tone };
}

/** What the decisions recorded when the event arrived say, one explanation per process. */
function explainRecorded(input: ExplainInput, byId: Map<string, ExplainProcess>): Explanation[] {
  const { event } = input;
  const out: Explanation[] = [];
  for (const [processId, list] of groupBy(input.decisions, (d) => d.processId)) {
    const proc = byId.get(processId);
    const who = { id: processId, name: proc?.name ?? '(deleted process)' };
    const hit = list.find((d) => d.result);
    if (hit) {
      const deduped = input.dispatches.some(
        (d) => d.processId === processId && d.outcome === 'deduped',
      );
      const name = triggerName(
        proc?.document.triggers.find((x) => x.id === hit.triggerId),
        hit.triggerId,
      );
      const r: Reason = deduped
        ? {
            text: `${name} matched, but it was deduped (already dispatched in the last ${DEDUPE_WINDOW_DAYS} days)`,
            tone: 'off',
          }
        : { text: `${name} matched`, tone: 'ok' };
      out.push(explanation(who, true, r, 'recorded'));
      continue;
    }
    const r = processReason(list, () =>
      list.map((d) => decisionReason(d, proc?.document, event.type)),
    );
    out.push(explanation(who, false, r, 'recorded'));
  }
  return out;
}

/** A process with nothing recorded, explained from its current configuration. */
function explainFromConfig(p: ExplainProcess, event: ExplainInput['event']): Explanation {
  const matchable = [{ id: p.id, enabled: p.enabled, document: p.document }];
  const skips = skippedTriggers(event, matchable);
  const r = processReason(skips, () => {
    const reasons = skips.map((k) =>
      decisionReason({ ...k, result: false }, p.document, event.type),
    );
    if (candidateTriggers(event, matchable).length > 0) {
      reasons.push({
        text: 'no decision was recorded; its triggers changed after the event arrived',
        tone: 'off',
      });
    }
    return reasons;
  });
  return explanation(p, false, r, 'now');
}

export function explainEvent(input: ExplainInput): Explanation[] {
  const { event } = input;
  if (event.stage === 'received') return [];
  // Processes created after the event could not have taken it; leave them out.
  const onSource = input.processes.filter(
    (p) =>
      p.createdAt <= event.receivedAt &&
      p.document.triggers.some((t) => t.sourceId === event.sourceId),
  );

  const door = doorReason(event.stage, event.type, event.stageReason);
  if (door) return onSource.map((p) => explanation(p, false, door, 'recorded'));

  const recorded = explainRecorded(input, new Map(input.processes.map((p) => [p.id, p])));
  const seen = new Set(recorded.map((x) => x.processId));
  const fromConfig = onSource
    .filter((p) => !seen.has(p.id))
    .map((p) => explainFromConfig(p, event));
  return [...recorded, ...fromConfig].sort(
    (a, b) => Number(b.taken) - Number(a.taken) || a.processName.localeCompare(b.processName),
  );
}

/** Null at door stages too: the stage label already says why. */
export function summarizeWhy(
  stage: EventStage,
  explanations: readonly Explanation[],
): string | null {
  if (stage !== 'unmatched' || explanations.some((x) => x.taken)) return null;
  const first = [...explanations].sort(byTone)[0];
  if (!first) return 'no process has a trigger on this source';
  const more = explanations.length > 1 ? ` (+${explanations.length - 1} more)` : '';
  return `${first.processName}: ${first.reason}${more}`;
}
