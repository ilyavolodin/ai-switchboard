import type { SourceCapsDTO, SourceDetail } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { useDeleteSource, useUpdateSource } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { deliverySample, EMPTY_SAMPLE, type SampleDraft } from '../../lib/sampleDelivery.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { SamplePreview } from './SamplePreview.js';
import { SourceCapsFields } from './SourceCapsFields.js';

/**
 * The source's Settings tab: the plugin's schema form, the core's caps and mute list, and a save
 * bar that asks for a reason. Delete lives at the bottom.
 */
export function SourceSettings({ source }: { source: SourceDetail }) {
  // A pasted sample delivery (push sources): the preview panel and the path fields use it.
  const [sample, setSample] = useState<SampleDraft>(EMPTY_SAMPLE);
  const push = source.mode !== 'pull';
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
      renderCaps={(caps, onChange, disabled, baseline) => (
        <SourceCapsFields
          value={caps}
          onChange={onChange}
          baseline={baseline}
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
      sample={push ? deliverySample(sample) : null}
      renderAfterSettings={
        push
          ? (settings) => (
              <SamplePreview
                typeId={source.typeId}
                settings={settings}
                sourceId={source.id}
                sample={sample}
                onSampleChange={setSample}
              />
            )
          : undefined
      }
    />
  );
}
