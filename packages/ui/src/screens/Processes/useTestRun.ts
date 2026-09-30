import type { RecentBatchDTO } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { useProcessBatches, useRunProcess } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { runStartedMessage, testRunPrompt } from '../shared/actionPrompts.js';
import { EXAMPLE_SWEEP } from './batches.js';

export interface TestRunControls {
  batches: RecentBatchDTO[];
  batchId: string;
  onBatchChange: (id: string) => void;
  dryRun: boolean;
  onDryRunChange: (dryRun: boolean) => void;
  pending: boolean;
  onRun: () => void;
}

/**
 * The batch a test run (and the input preview) uses, newest first until one is picked, and the
 * reasoned run of the saved version.
 */
export function useTestRun(processId: string | undefined, processName: string): TestRunControls {
  const batches = useProcessBatches(processId);
  const [choice, setChoice] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const list = batches.data ?? [];
  const batchId = choice ?? list[0]?.id ?? EXAMPLE_SWEEP;
  const mutation = useReasonedMutation(
    useRunProcess(),
    (v) => testRunPrompt(processName, v.dryRun === true),
    { successMessage: (r) => runStartedMessage('Test run', r) },
  );
  return {
    batches: list,
    batchId,
    onBatchChange: setChoice,
    dryRun,
    onDryRunChange: setDryRun,
    pending: mutation.pending,
    onRun: () => {
      if (!processId) return;
      void mutation.run({ id: processId, dryRun, ...(batchId ? { batchId } : {}) });
    },
  };
}
