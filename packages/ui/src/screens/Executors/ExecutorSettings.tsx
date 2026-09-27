import type { ExecutorCapsDTO, ExecutorDetail } from '@ai-switchboard/core/contract';

import { useDeleteExecutor, useUpdateExecutor } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { InstanceSettingsForm } from '../shared/InstanceSettingsForm.js';
import { ExecutorCapsFields } from './ExecutorCapsFields.js';
import { estimatedMeters } from './executorModel.js';

/**
 * The executor's Settings tab: the plugin's schema form, the core's caps (runs, usage per day,
 * meter poll, staleness, estimated limits) and a save bar that asks for a reason.
 */
export function ExecutorSettings({ executor }: { executor: ExecutorDetail }) {
  const save = useReasonedMutation(
    useUpdateExecutor(),
    {
      title: `Save ${executor.name}?`,
      consequence:
        'The live plugin object is re-created with the new settings; runs already started keep being tracked. New caps apply to the next budget check.',
      confirmLabel: 'Save changes',
    },
    { successMessage: 'Settings saved' },
  );
  const remove = useReasonedMutation(
    useDeleteExecutor(),
    {
      title: `Delete ${executor.name}?`,
      consequence:
        executor.processes.length > 0
          ? `${executor.processes.map((p) => p.name).join(', ')} lose their executor and hold every batch until they are bound to another one.`
          : 'It disappears from the Board and the capacity strip. Its run history stays until retention removes it.',
      confirmLabel: 'Delete executor',
      danger: true,
    },
    { successMessage: `${executor.name} deleted` },
  );

  return (
    <InstanceSettingsForm<ExecutorCapsDTO>
      entity={executor}
      kind="executor"
      renderCaps={(caps, onChange, disabled) => (
        <ExecutorCapsFields
          value={caps}
          onChange={onChange}
          baseline={executor.caps}
          usage={executor.usage}
          estimated={estimatedMeters(executor.meterSpecs, executor.meters)}
          hasMeters={executor.meterSpecs.length > 0}
          disabled={disabled}
        />
      )}
      onSave={(draft) => save.run({ id: executor.id, ...draft })}
      saving={save.pending}
      onDelete={() => remove.run({ id: executor.id })}
      deleting={remove.pending}
      deleteNote="Deleting removes the instance. Processes bound to it hold their batches until they are bound to another executor."
      afterDelete="/executors"
    />
  );
}
