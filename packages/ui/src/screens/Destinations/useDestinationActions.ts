import type { DestinationSummary } from '@ai-switchboard/core/contract';

import { useEnableDestination, useReloadDestination } from '../../api/index.js';
import { type InstanceActions, useInstanceActions } from '../shared/useInstanceActions.js';
import { enableDestinationPrompt } from './destinationModel.js';

export function useDestinationActions(
  destination: Pick<DestinationSummary, 'id' | 'name' | 'processCount'>,
): InstanceActions {
  return useInstanceActions({
    noun: 'destination',
    entity: destination,
    enable: useEnableDestination(),
    reload: useReloadDestination(),
    enablePrompt: (enabled) => enableDestinationPrompt(destination, enabled),
  });
}
