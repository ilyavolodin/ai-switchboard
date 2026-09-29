import { createHash } from 'node:crypto';

import {
  draftFromMapped,
  type EventDraft,
  type EventTypeSpec,
  type MappedEvent,
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
 * The event for one mapped result. Without a version or delivery id, quick and mapped modes
 * fall back to a hash of the body, so such a delivery collapses only with an identical redelivery.
 */
export function draftFor(
  delivery: Delivery,
  mapped: MappedEvent,
  options: { hashFallback: boolean },
): EventDraft {
  return draftFromMapped(mapped, {
    occurredAt: delivery.receivedAt,
    deliveryId: delivery.deliveryId,
    fallbackDiscriminator: options.hashFallback ? `body-${bodyHash(delivery.raw)}` : undefined,
  });
}
