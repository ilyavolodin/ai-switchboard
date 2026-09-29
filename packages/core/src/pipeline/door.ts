import {
  validateAgainst,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type EventTypeSpec,
} from '@ai-switchboard/sdk';

import type { EventStage } from '../domain/status.js';
import { errorText } from '../util/errors.js';

/**
 * The receive stage: every drafted event is checked and given a stage at the door (disabled
 * source, invalid, muted type, over the source's event caps) before anything matches it.
 */

/** Stages that count against a source's event caps. */
export const ACCEPTED_STAGES = [
  'received',
  'matched',
  'unmatched',
] as const satisfies readonly EventStage[];

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Shorter values would redact or flag ordinary text. */
export function matchableSecrets(values: readonly string[]): string[] {
  return values.filter((s) => s.length >= 4);
}

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

export function checkDraft(draft: unknown, live: DraftChecker, now: Date): CheckedDraft {
  const d = (draft !== null && typeof draft === 'object' ? draft : {}) as Partial<
    Record<keyof EventDraft, unknown>
  >;
  const problems: string[] = [];
  const type = typeof d.type === 'string' && d.type !== '' ? d.type : '(invalid)';
  const rawArtifact = (
    d.artifact !== null && typeof d.artifact === 'object' ? d.artifact : {}
  ) as Record<string, unknown>;
  const artifact: ArtifactRef = {
    kind: typeof rawArtifact.kind === 'string' ? rawArtifact.kind : '(invalid)',
    id: typeof rawArtifact.id === 'string' ? rawArtifact.id : '',
    ...(typeof rawArtifact.url === 'string' ? { url: rawArtifact.url } : {}),
    ...(typeof rawArtifact.version === 'string' ? { version: rawArtifact.version } : {}),
  };
  const attributes = (
    d.attributes !== null && typeof d.attributes === 'object' && !Array.isArray(d.attributes)
      ? structuredClone(d.attributes)
      : {}
  ) as Attributes;
  const occurred = typeof d.occurredAt === 'string' ? new Date(d.occurredAt) : new Date(Number.NaN);
  const dedupeKey = typeof d.dedupeKey === 'string' ? d.dedupeKey : '';

  if (draft === null || typeof draft !== 'object') problems.push('event is not an object');
  const spec = live.eventTypes.find((t) => t.type === type);
  if (!spec) problems.push(`event type ${type} is not declared by ${live.typeId}`);
  if (artifact.kind === '(invalid)' || artifact.kind === '' || artifact.id === '') {
    problems.push('artifact must have a kind and an id');
  }
  if (dedupeKey === '') problems.push('dedupeKey is missing');
  if (Number.isNaN(occurred.getTime())) problems.push('occurredAt is not an ISO-8601 time');
  for (const [k, v] of Object.entries(attributes)) {
    if (!isFlatValue(v)) problems.push(`attribute ${k} is not a scalar or a string array`);
  }
  if (spec) {
    try {
      const check = validateAgainst(spec.attributes, structuredClone(attributes));
      problems.push(...check.errors);
    } catch (err) {
      problems.push(`declared attribute schema is invalid: ${errorText(err)}`);
    }
  }
  const secrets = matchableSecrets(live.secretValues);
  if (secrets.length > 0) {
    const text = JSON.stringify(attributes);
    if (secrets.some((s) => text.includes(s)))
      problems.push('an attribute contains a secret value');
  }
  return {
    stage: problems.length > 0 ? 'event_invalid' : null,
    reason: problems.length > 0 ? problems.join('; ').slice(0, 1000) : null,
    problems,
    type,
    occurredAt: Number.isNaN(occurred.getTime()) ? now : occurred,
    artifact,
    attributes: problems.length > 0 && !spec ? {} : attributes,
    dedupeKey,
    deliveryId: typeof d.deliveryId === 'string' && d.deliveryId !== '' ? d.deliveryId : null,
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
