import { createHash } from 'node:crypto';

import {
  dedupeKey,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type EventTypeSpec,
} from '@ai-switchboard/sdk';

import type { DeliveryView } from './paths.js';

/** One delivery as every mode sees it. */
export interface Delivery extends DeliveryView {
  /** The exact bytes received, for the body hash. */
  raw: Buffer;
  receivedAt: string;
  /** The sender's delivery id from the configured header, when there is one. */
  deliveryId: string | undefined;
}

/** What a mode produced for one delivery, and why parts of it produced nothing. */
export interface MapResult {
  events: EventDraft[];
  notes: string[];
}

/** A compiled mode: the event types it declares and the function from a delivery to events. */
export interface Mapper {
  eventTypes: EventTypeSpec[];
  map(delivery: Delivery): Promise<MapResult>;
}

/** A short, stable hash of the raw body: the same bytes always give the same value. */
export function bodyHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * The event for one mapped result. The dedupe key uses the artifact version, else the
 * delivery id, else (quick and mapped modes) a hash of the body, so a delivery without any of
 * them still collapses only with an identical redelivery.
 */
export function draftFor(
  delivery: Delivery,
  mapped: {
    type: string;
    artifact: ArtifactRef;
    attributes: Attributes;
    occurredAt: string | undefined;
    deliveryId: string | undefined;
  },
  options: { hashFallback: boolean },
): EventDraft {
  const deliveryId = mapped.deliveryId ?? delivery.deliveryId;
  const discriminator =
    deliveryId ?? (options.hashFallback ? `body-${bodyHash(delivery.raw)}` : undefined);
  return {
    type: mapped.type,
    occurredAt: mapped.occurredAt ?? delivery.receivedAt,
    artifact: mapped.artifact,
    attributes: mapped.attributes,
    dedupeKey: dedupeKey(mapped.type, mapped.artifact, discriminator),
    ...(deliveryId !== undefined ? { deliveryId } : {}),
  };
}
