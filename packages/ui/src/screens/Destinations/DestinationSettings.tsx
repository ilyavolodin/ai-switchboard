import type { DestinationCapsDTO, DestinationDetail } from '@ai-switchboard/core/contract';

import { useDeleteDestination, useUpdateDestination } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { InUseBanner } from '../shared/InUseBanner.js';
import { useInUseRefusal } from '../shared/useInUseRefusal.js';
import { DestinationCapsFields } from './DestinationCapsFields.js';
import { estimatedMeters } from './destinationModel.js';

/**
 * The destination's Settings tab: the plugin's schema form, the core's caps (runs, usage per day,
 * meter poll, staleness, estimated limits) and a save bar that asks for a reason.
 */
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
  const inUse = useInUseRefusal();
  const remove = useReasonedMutation(
    useDeleteDestination(),
    {
      title: `Delete ${destination.name}?`,
      consequence:
        'It disappears from the Board and the capacity strip. Its run history stays until retention removes it.',
      confirmLabel: 'Delete destination',
      danger: true,
    },
    { successMessage: `${destination.name} deleted`, onError: inUse.onError },
  );

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
      onDelete={() => {
        // Processes bound to it: the server would refuse, so say why at once.
        if (destination.processes.length > 0) {
          inUse.block(destination.processes);
          return Promise.resolve(null);
        }
        return remove.run({ id: destination.id });
      }}
      deleting={remove.pending}
      deleteNote="Deleting removes the instance. A destination that processes are bound to (or whose actions their steps use) can't be deleted: bind them elsewhere first."
      afterDelete="/destinations"
      deleteBlocked={
        inUse.usedBy && (
          <InUseBanner
            name={destination.name}
            kind="destination"
            processes={inUse.usedBy}
            onDismiss={inUse.dismiss}
          />
        )
      }
    />
  );
}
