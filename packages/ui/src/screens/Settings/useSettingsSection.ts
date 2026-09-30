import { useUpdateSettings } from '../../api/index.js';
import { type ReasonPromptOptions, useReasonedMutation } from '../../hooks/reason.js';
import { useLeaveGuard } from '../../hooks/useLeaveGuard.js';
import { useSettingsDraft } from '../../hooks/useSettingsDraft.js';
import type { SectionCheck } from './settingsForm.js';

export interface SettingsSectionOptions<F extends object> {
  /** The saved settings as form text. */
  form: F;
  check: (form: F) => SectionCheck<F>;
  prompt: ReasonPromptOptions;
  successMessage: string;
}

/**
 * One settings card's form: the draft, what it would save, and the reasoned save. It has unsaved
 * changes when it would save something or holds a value that cannot be saved.
 */
export function useSettingsSection<F extends object>({
  form: saved,
  check,
  prompt,
  successMessage,
}: SettingsSectionOptions<F>) {
  const form = useSettingsDraft(saved);
  const { patch, errors } = check(form.draft);
  const invalid = Object.keys(errors).length > 0;
  const dirty = invalid || Object.keys(patch).length > 0;
  const leaveGuard = useLeaveGuard(dirty);
  const mutation = useReasonedMutation(useUpdateSettings(), prompt, { successMessage });
  return {
    draft: form.draft,
    set: form.set,
    discard: form.discard,
    errors,
    dirty,
    invalid,
    leaveGuard,
    saving: mutation.pending,
    save: () => void mutation.run({ settings: patch }),
  };
}

export type SettingsSaveState = Pick<
  ReturnType<typeof useSettingsSection>,
  'dirty' | 'invalid' | 'saving' | 'save' | 'discard' | 'leaveGuard'
>;
