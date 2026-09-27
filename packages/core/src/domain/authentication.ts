import type { Source, SourceType } from '@ai-switchboard/sdk';

/**
 * Whether a built source instance accepts deliveries without verification. That is the case
 * exactly when its type allows it (`allowsUnauthenticated`, the generic webhook) and the plugin
 * built the instance without `verify` (the webhook's `verification: none`). The plugin's own
 * setting is the single switch: `caps.unauthenticated` is derived from this, never chosen.
 */
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
