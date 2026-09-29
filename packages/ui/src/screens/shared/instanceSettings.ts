import { sameValue, withoutUndefined } from '../../lib/instances.js';

export interface InstanceSettingsDraft<C> {
  name: string;
  settings: Record<string, unknown>;
  caps: C;
}

/**
 * Derived by the core, never taken from a request: `unauthenticated` follows from the source's
 * verification setting.
 */
const DERIVED_CAPS = ['unauthenticated'];

export function editableCaps<C extends object>(caps: C): C {
  return Object.fromEntries(
    Object.entries(withoutUndefined(caps)).filter(([k]) => !DERIVED_CAPS.includes(k)),
  ) as C;
}

/**
 * Caps compare without `undefined` keys (clearing back to "no cap" is not a change) and without
 * core-derived fields; all parts compare canonically.
 */
export function instanceChangeCount<C extends object>(
  draft: InstanceSettingsDraft<C>,
  saved: InstanceSettingsDraft<C>,
): number {
  return [
    draft.name !== saved.name,
    !sameValue(draft.settings, saved.settings),
    !sameValue(editableCaps(draft.caps), editableCaps(saved.caps)),
  ].filter(Boolean).length;
}
