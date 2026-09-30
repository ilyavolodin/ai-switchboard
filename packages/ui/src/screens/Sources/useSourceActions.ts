import type { SourceSummary } from '@ai-switchboard/core/contract';

import { useEnableSource, useReloadSource } from '../../api/index.js';
import { type InstanceActions, useInstanceActions } from '../shared/useInstanceActions.js';
import { enableSourcePrompt } from './sourceModel.js';

export function useSourceActions(
  source: Pick<SourceSummary, 'id' | 'name' | 'processCount'>,
): InstanceActions {
  return useInstanceActions({
    noun: 'source',
    entity: source,
    enable: useEnableSource(),
    reload: useReloadSource(),
    enablePrompt: (enabled) => enableSourcePrompt(source, enabled),
  });
}
