import type { DestinationCapsDTO, DestinationDetail } from '@ai-switchboard/core/contract';

import { useDeleteDestination, useUpdateDestination } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { useInstanceDelete } from '../shared/useInstanceDelete.js';
import { DestinationCapsFields } from './DestinationCapsFields.js';
import { estimatedMeters } from './destinationModel.js';

export function DestinationSettings({ destination }: { destination: DestinationDetail }) {
  const save = useReasonedMutation(
    useUpdateDestination(),
    {
      title: `Save ${destination.name}?`,
      consequence:
        'The live plugin object is re-created with the new settings; runs already started keep being tracked. New caps apply to the next budget check.',
      confirmLabel: 'Save changes',
    },
    { successMessage: 'Settings saved' },
  );
  const deletion = useInstanceDelete({
    noun: 'destination',
    entity: destination,
    mutation: useDeleteDestination(),
    consequence:
      'It disappears from the Board and the capacity strip. Its run history stays until retention removes it.',
  });

  return (
    <InstanceSettingsForm<DestinationCapsDTO>
      entity={destination}
      kind="destination"
      renderCaps={(caps, onChange, disabled, baseline) => (
        <DestinationCapsFields
          value={caps}
          onChange={onChange}
          baseline={baseline}
          usage={destination.usage}
          estimated={estimatedMeters(destination.meterSpecs, destination.meters)}
          hasMeters={destination.meterSpecs.length > 0}
          disabled={disabled}
        />
      )}
      onSave={(draft) => save.run({ id: destination.id, ...draft })}
      saving={save.pending}
      deletion={deletion}
      deleteNote="Deleting removes the instance. A destination that processes are bound to (or whose actions their steps use) can't be deleted: bind them elsewhere first."
      afterDelete="/destinations"
    />
  );
}
