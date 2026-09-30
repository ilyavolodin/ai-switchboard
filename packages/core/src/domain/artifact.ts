import type { ArtifactRef } from '@ai-switchboard/sdk';
import { isRecord } from '@ai-switchboard/sdk/json';

/** The `ArtifactRef` fields of an untrusted value that are strings; the rest are left out. */
export function artifactFields(value: unknown): Partial<ArtifactRef> {
  if (!isRecord(value)) return {};
  const out: Partial<ArtifactRef> = {};
  if (typeof value.kind === 'string') out.kind = value.kind;
  if (typeof value.id === 'string') out.id = value.id;
  if (typeof value.url === 'string') out.url = value.url;
  if (typeof value.version === 'string') out.version = value.version;
  return out;
}

/** A clean `ArtifactRef` (no extra keys), or null without a string `kind` and `id`. */
export function toArtifactRef(value: unknown): ArtifactRef | null {
  const { kind, id, ...rest } = artifactFields(value);
  return kind !== undefined && id !== undefined ? { kind, id, ...rest } : null;
}
