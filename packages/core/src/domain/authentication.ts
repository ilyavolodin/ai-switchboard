import type { Source, SourceType } from '@ai-switchboard/sdk';

/** `caps.unauthenticated` is derived from this, never chosen: the plugin's setting is the one switch. */
export function acceptsUnauthenticated(
  type: Pick<SourceType, 'allowsUnauthenticated' | 'mode'> | undefined,
  source: Pick<Source, 'verify'> | undefined,
): boolean {
  return (
    type?.allowsUnauthenticated === true &&
    type.mode !== 'pull' &&
    source !== undefined &&
    typeof source.verify !== 'function'
  );
}
