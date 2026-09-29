import { createHash } from 'node:crypto';

import {
  dedupeKey,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type EventTypeSpec,
} from '@ai-switchboard/sdk';

import type { DeliveryView } from './paths.js';

export interface Delivery extends DeliveryView {
  raw: Buffer;
  receivedAt: string;
  deliveryId: string | undefined;
}

export interface MapResult {
  events: EventDraft[];
  notes: string[];
}

export interface Mapper {
  eventTypes: EventTypeSpec[];
  map(delivery: Delivery): Promise<MapResult>;
}

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
