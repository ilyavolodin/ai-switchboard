/** Pure helpers for the source and executor Settings tabs. */
import { sameValue, withoutUndefined } from '../../lib/instances.js';

/** The editable part of a source or executor instance. */
export interface InstanceSettingsDraft<C> {
  name: string;
  settings: Record<string, unknown>;
  caps: C;
}

/**
 * Caps fields the core derives and never takes from a request: `unauthenticated` follows from the
 * source's verification setting. They are not edited, sent, or counted as a change.
 */
const DERIVED_CAPS = ['unauthenticated'];

/** The caps a person edits: no `undefined` keys, no core-derived fields. */
export function editableCaps<C extends object>(caps: C): C {
  return Object.fromEntries(
    Object.entries(withoutUndefined(caps)).filter(([k]) => !DERIVED_CAPS.includes(k)),
  ) as C;
}

/**
 * How many of the three parts (name, plugin settings, core caps) differ from what is saved. Caps
 * compare without `undefined` keys, so clearing a field back to "no cap" is not a change, and
 * without core-derived fields. All parts compare canonically (key order does not matter).
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
