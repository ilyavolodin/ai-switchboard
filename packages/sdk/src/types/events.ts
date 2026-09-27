import type { IsoDateTime, JSONSchema } from './common.js';

/** The durable thing an event is about. */
export interface ArtifactRef {
  /** `'github.pr' | 'linear.issue' | 'datadog.monitor' | ...` */
  kind: string;
  /** `'482' | 'LOL-1712' | '<monitor id>'` */
  id: string;
  url?: string;
  /** Source updated-at or etag; part of the dedupe key. */
  version?: string;
}

/** Flat facts about an event, validated against the event type's declared schema. */
export type Attributes = Record<string, string | number | boolean | string[]>;

/** One normalised occurrence from a source. */
export interface Event {
  /** uuid, assigned by the core. */
  id: string;
  /** The source instance. */
  sourceId: string;
  /** e.g. `'github'` */
  sourceType: string;
  /** `'<sourceType>.<object>.<verb>'`, e.g. `'github.pr.labeled'` */
  type: string;
  /** From the source when it has one. */
  occurredAt: IsoDateTime;
  /** Core clock. */
  receivedAt: IsoDateTime;
  artifact: ArtifactRef;
  attributes: Attributes;
  /** Stable for the same change delivered twice. */
  dedupeKey: string;
  /** The source's own delivery id when it has one. */
  deliveryId?: string;
  /** Pointer to the stored raw body. */
  rawRef: string;
  /** Set when this event was re-injected from a stored raw body. */
  replayOf?: string;
}

/**
 * What a source plugin produces from `parse` or `poll`. The core assigns `id`, `sourceId`,
 * `sourceType`, `receivedAt` and `rawRef`.
 */
export type EventDraft = Omit<
  Event,
  'id' | 'sourceId' | 'sourceType' | 'receivedAt' | 'rawRef' | 'replayOf'
>;

export interface EventTypeSpec {
  /** `'github.pr.labeled'` */
  type: string;
  /** `'Pull request labeled'` */
  title: string;
  description: string;
  /** Object schema, flat properties only. */
  attributes: JSONSchema;
  /** Shown in the UI's filter editor. At least one is required by the conformance kit. */
  examples: Attributes[];
}

/** Live state of an artifact returned by `Source.resolve`; shape is source-specific. */
export interface ArtifactSnapshot {
  ref: ArtifactRef;
  [key: string]: unknown;
}

/**
 * The canonical dedupe key: `${type}:${artifact.kind}:${artifact.id}:${artifact.version ?? deliveryId}`.
 */
export function dedupeKey(type: string, artifact: ArtifactRef, deliveryId?: string): string {
  return `${type}:${artifact.kind}:${artifact.id}:${artifact.version ?? deliveryId ?? ''}`;
}
