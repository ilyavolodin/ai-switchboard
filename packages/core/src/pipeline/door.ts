import {
  isRecord,
  validateAgainst,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type EventTypeSpec,
} from '@ai-switchboard/sdk';

import { artifactFields } from '../domain/artifact.js';
import type { EventStage } from '../domain/status.js';
import { matchableSecrets } from '../secrets/refs.js';
import { errorText } from '../util/errors.js';
import { str } from '../util/guards.js';

/**
 * The receive stage: every drafted event is checked and given a stage at the door (disabled
 * source, invalid, muted type, over the source's event caps) before anything matches it.
 */

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Headers as stored: credentials dropped, any header carrying a secret value redacted. */
export function storedHeaders(
  headers: Record<string, string | undefined>,
  secretValues: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const secrets = matchableSecrets(secretValues);
  for (const [k, v] of Object.entries(headers)) {
    if (DROPPED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v !== undefined && secrets.some((s) => v.includes(s)) ? '[redacted]' : v;
  }
  return out;
}

export interface DraftChecker {
  typeId: string;
  eventTypes: readonly EventTypeSpec[];
  secretValues: readonly string[];
}

export interface CheckedDraft {
  stage: EventStage | null;
  reason: string | null;
  /** `reason` joins them. */
  problems: string[];
  type: string;
  occurredAt: Date;
  artifact: ArtifactRef;
  attributes: Attributes;
  dedupeKey: string;
  deliveryId: string | null;
}

function isFlatValue(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    (Array.isArray(v) && v.every((x) => typeof x === 'string'))
  );
}

const INVALID = '(invalid)';

/** A plugin's draft read field by field; anything missing or mistyped gets a placeholder. */
export interface ParsedDraft {
  isObject: boolean;
  type: string;
  /** Null when `occurredAt` is missing or not a time. */
  occurredAt: Date | null;
  artifact: ArtifactRef;
  attributes: Attributes;
  dedupeKey: string;
  deliveryId: string | null;
}

export function parseDraft(draft: unknown): ParsedDraft {
  const d: Partial<Record<keyof EventDraft, unknown>> = isRecord(draft) ? draft : {};
  const occurred = typeof d.occurredAt === 'string' ? new Date(d.occurredAt) : null;
  const { kind, id, ...artifactRest } = artifactFields(d.artifact);
  return {
    isObject: isRecord(draft),
    type: str(d.type) ?? INVALID,
    occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
    artifact: { kind: kind ?? INVALID, id: id ?? '', ...artifactRest },
    attributes: (isRecord(d.attributes) ? structuredClone(d.attributes) : {}) as Attributes,
    dedupeKey: typeof d.dedupeKey === 'string' ? d.dedupeKey : '',
    deliveryId: str(d.deliveryId) ?? null,
  };
}

/** Everything wrong with a parsed draft, in the order a person should fix it. */
export function draftProblems(
  draft: ParsedDraft,
  spec: EventTypeSpec | undefined,
  live: DraftChecker,
): string[] {
  const problems: string[] = [];
  if (!draft.isObject) problems.push('event is not an object');
  if (!spec) problems.push(`event type ${draft.type} is not declared by ${live.typeId}`);
  const { kind, id } = draft.artifact;
  if (kind === INVALID || kind === '' || id === '') {
    problems.push('artifact must have a kind and an id');
  }
  if (draft.dedupeKey === '') problems.push('dedupeKey is missing');
  if (draft.occurredAt === null) problems.push('occurredAt is not an ISO-8601 time');
  for (const [k, v] of Object.entries(draft.attributes)) {
    if (!isFlatValue(v)) problems.push(`attribute ${k} is not a scalar or a string array`);
  }
  if (spec) {
    try {
      problems.push(...validateAgainst(spec.attributes, structuredClone(draft.attributes)).errors);
    } catch (err) {
      problems.push(`declared attribute schema is invalid: ${errorText(err)}`);
    }
  }
  const secrets = matchableSecrets(live.secretValues);
  if (secrets.length > 0) {
    const text = JSON.stringify(draft.attributes);
    if (secrets.some((s) => text.includes(s))) {
      problems.push('an attribute contains a secret value');
    }
  }
  return problems;
}

export function checkDraft(draft: unknown, live: DraftChecker, now: Date): CheckedDraft {
  const parsed = parseDraft(draft);
  const spec = live.eventTypes.find((t) => t.type === parsed.type);
  const problems = draftProblems(parsed, spec, live);
  const invalid = problems.length > 0;
  return {
    stage: invalid ? 'event_invalid' : null,
    reason: invalid ? problems.join('; ').slice(0, 1000) : null,
    problems,
    type: parsed.type,
    occurredAt: parsed.occurredAt ?? now,
    artifact: parsed.artifact,
    attributes: invalid && !spec ? {} : parsed.attributes,
    dedupeKey: parsed.dedupeKey,
    deliveryId: parsed.deliveryId,
  };
}

export interface DoorCaps {
  eventCapPerHour?: number | undefined;
  eventCapPerDay?: number | undefined;
  eventTypesEnabled?: string[] | undefined;
}

/** Events already accepted from the source in the rolling hour and day. */
export interface DoorCounts {
  hour: number;
  day: number;
}

/** Operator-injected events (test events, replays) skip the caps. */
export function capsApply(caps: DoorCaps, bypass: boolean): boolean {
  return !bypass && (caps.eventCapPerHour !== undefined || caps.eventCapPerDay !== undefined);
}

/**
 * `counts` is null when the caps don't apply. An accepted event is counted, so later drafts of
 * the same delivery see it.
 */
export function doorStage(
  checked: Pick<CheckedDraft, 'stage' | 'reason' | 'type'>,
  source: { enabled: boolean; caps: DoorCaps },
  counts: DoorCounts | null,
): { stage: EventStage; reason: string | null; counts: DoorCounts | null } {
  const { caps } = source;
  if (!source.enabled) return { stage: 'source_disabled', reason: checked.reason, counts };
  if (checked.stage === 'event_invalid') {
    return { stage: 'event_invalid', reason: checked.reason, counts };
  }
  if (caps.eventTypesEnabled !== undefined && !caps.eventTypesEnabled.includes(checked.type)) {
    return { stage: 'type_muted', reason: checked.reason, counts };
  }
  if (counts !== null) {
    if (caps.eventCapPerHour !== undefined && counts.hour >= caps.eventCapPerHour) {
      return {
        stage: 'source_throttled',
        reason: `eventCapPerHour ${caps.eventCapPerHour}`,
        counts,
      };
    }
    if (caps.eventCapPerDay !== undefined && counts.day >= caps.eventCapPerDay) {
      return { stage: 'source_throttled', reason: `eventCapPerDay ${caps.eventCapPerDay}`, counts };
    }
  }
  return {
    stage: 'received',
    reason: checked.reason,
    counts: counts === null ? null : { hour: counts.hour + 1, day: counts.day + 1 },
  };
}

const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 500;

/** A plugin's notes on what produced no event: strings only, bounded, for a log line. */
export function sourceNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .slice(0, MAX_NOTES)
    .map((n) => n.slice(0, MAX_NOTE_LENGTH));
}
