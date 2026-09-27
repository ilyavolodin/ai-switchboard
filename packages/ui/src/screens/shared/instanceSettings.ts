/** Pure helpers for the source and executor Settings tabs. */
import { sameValue, withoutUndefined } from '../../lib/instances.js';

/** The editable part of a source or executor instance. */
export interface InstanceSettingsDraft<C> {
  name: string;
  settings: Record<string, unknown>;
  caps: C;
}

/**
 * How many of the three parts (name, plugin settings, core caps) differ from what is saved. Caps
 * compare without `undefined` keys, so clearing a field back to "no cap" is not a change.
 */
export function instanceChangeCount<C extends object>(
  draft: InstanceSettingsDraft<C>,
  saved: InstanceSettingsDraft<C>,
): number {
  return [
    draft.name !== saved.name,
    !sameValue(draft.settings, saved.settings),
    !sameValue(withoutUndefined(draft.caps), withoutUndefined(saved.caps)),
  ].filter(Boolean).length;
}
