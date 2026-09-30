import type { SourceCapsDTO, SourceDetail } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { useDeleteSource, useUpdateSource } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { deliverySample, EMPTY_SAMPLE, type SampleDraft } from '../../lib/sampleDelivery.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { useInstanceDelete } from '../shared/useInstanceDelete.js';
import { SamplePreview } from './SamplePreview.js';
import { SourceCapsFields } from './SourceCapsFields.js';

export function SourceSettings({ source }: { source: SourceDetail }) {
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
  const deletion = useInstanceDelete({
    noun: 'source',
    entity: source,
    mutation: useDeleteSource(),
    consequence:
      'Its webhook URL answers 404 and it disappears from the Board. Recorded events stay until retention removes them.',
  });

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
      deletion={deletion}
      deleteNote="Deleting removes the instance and its webhook URL. A source that processes still use can't be deleted: remove their triggers on it first."
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
