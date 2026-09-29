import type { IsoDateTime, JSONSchema } from './common.js';

/** The durable thing an event is about. */
export interface ArtifactRef {
  /** e.g. `'github.pr'`, `'linear.issue'` */
  kind: string;
  id: string;
  url?: string;
  /** Source updated-at or etag; part of the dedupe key. */
  version?: string;
}

/** Flat facts about an event, validated against the event type's declared schema. */
export type Attributes = Record<string, string | number | boolean | string[]>;

export interface Event {
  id: string;
  /** The source instance. */
  sourceId: string;
  sourceType: string;
  /** `'<sourceType>.<object>.<verb>'`, e.g. `'github.pr.labeled'` */
  type: string;
  /** From the source when it has one. */
  occurredAt: IsoDateTime;
  receivedAt: IsoDateTime;
  artifact: ArtifactRef;
  attributes: Attributes;
  /** Stable for the same change delivered twice. */
  dedupeKey: string;
  deliveryId?: string;
  /** Pointer to the stored raw body. */
  rawRef: string;
  /** Set when this event was re-injected from a stored raw body. */
  replayOf?: string;
}

/** What `parse` / `poll` produce; the core fills in the rest. */
export type EventDraft = Omit<
  Event,
  'id' | 'sourceId' | 'sourceType' | 'receivedAt' | 'rawRef' | 'replayOf'
>;

export interface EventTypeSpec {
  /** `'<sourceType>.<object>.<verb>'` */
  type: string;
  title: string;
  description: string;
  /** Object schema, flat properties only. */
  attributes: JSONSchema;
  /** Shown in the UI's filter editor. At least one is required by the conformance kit. */
  examples: Attributes[];
}

/** Shape is source-specific. */
export interface ArtifactSnapshot {
  ref: ArtifactRef;
  [key: string]: unknown;
}

/** The canonical dedupe key. */
export function dedupeKey(type: string, artifact: ArtifactRef, deliveryId?: string): string {
  return `${type}:${artifact.kind}:${artifact.id}:${artifact.version ?? deliveryId ?? ''}`;
}
