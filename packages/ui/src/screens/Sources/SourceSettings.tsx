import type { SourceCapsDTO, SourceDetail } from '@ai-switchboard/core/contract';

import { useDeleteSource, useUpdateSource } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { SourceCapsFields } from './SourceCapsFields.js';

/**
 * The source's Settings tab: the plugin's schema form, the core's caps and mute list, and a save
 * bar that asks for a reason. Delete lives at the bottom.
 */
export function SourceSettings({ source }: { source: SourceDetail }) {
  const save = useReasonedMutation(
    useUpdateSource(),
    {
      title: `Save ${source.name}?`,
      consequence:
        'The live plugin object is re-created with the new settings; deliveries in flight finish first.',
      confirmLabel: 'Save changes',
    },
    { successMessage: 'Settings saved' },
  );
  const remove = useReasonedMutation(
    useDeleteSource(),
    {
      title: `Delete ${source.name}?`,
      consequence:
        source.processes.length > 0
          ? `Its triggers stop matching: ${source.processes.map((p) => p.name).join(', ')} will no longer receive its events. Its webhook URL answers 404.`
          : 'Its webhook URL answers 404 and it disappears from the Board. Recorded events stay until retention removes them.',
      confirmLabel: 'Delete source',
      danger: true,
    },
    { successMessage: `${source.name} deleted` },
  );

  return (
    <InstanceSettingsForm<SourceCapsDTO>
      entity={source}
      kind="source"
      renderCaps={(caps, onChange, disabled) => (
        <SourceCapsFields
          value={caps}
          onChange={onChange}
          baseline={source.caps}
          eventTypes={source.eventTypes}
          mode={source.mode}
          disabled={disabled}
        />
      )}
      onSave={(draft) => save.run({ id: source.id, ...draft })}
      saving={save.pending}
      onDelete={() => remove.run({ id: source.id })}
      deleting={remove.pending}
      deleteNote="Deleting removes the instance and its webhook URL. Processes keep their triggers but stop matching."
      afterDelete="/sources"
    />
  );
}
