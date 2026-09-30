import type { ArtifactRef } from './types/events.js';

/** The canonical dedupe key. */
export function dedupeKey(type: string, artifact: ArtifactRef, deliveryId?: string): string {
  return `${type}:${artifact.kind}:${artifact.id}:${artifact.version ?? deliveryId ?? ''}`;
}
