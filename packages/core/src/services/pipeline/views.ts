import type { Event } from '@ai-switchboard/sdk';

import type { batches, events, processes, runs } from '../../db/schema.js';

export type EventRow = typeof events.$inferSelect;
export type ProcessRow = typeof processes.$inferSelect;
export type BatchRow = typeof batches.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    artifact: row.artifact,
    attributes: row.attributes,
    dedupeKey: row.dedupeKey,
    ...(row.deliveryId !== null ? { deliveryId: row.deliveryId } : {}),
    rawRef: row.rawRef,
    ...(row.replayOf !== null ? { replayOf: row.replayOf } : {}),
  };
}

export function processView(row: ProcessRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.document.description,
    enabled: row.enabled,
    version: row.version,
  };
}

export function runView(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    processId: run.processId,
    destinationId: run.destinationId,
    status: run.status,
    reason: run.statusReason,
    mode: run.kind,
    dryRun: run.dryRun,
    externalId: run.externalId,
    externalUrl: run.externalUrl,
    usage: run.usage,
    invokedAt: run.invokedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
