import type { ProcessDetail } from '@ai-switchboard/core/contract';
import { useNavigate } from 'react-router';

import {
  useDeleteProcess,
  useEnableProcess,
  useResetBreaker,
  useRunProcess,
} from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import {
  deleteProcessPrompt,
  enableProcessPrompt,
  resetBreakerPrompt,
  runProcessPrompt,
  runStartedMessage,
} from '../shared/actionPrompts.js';
import { deleteConsequence, enableConsequence } from './detailModel.js';

export interface ProcessAction {
  pending: boolean;
  run: () => void;
}

/** The reasoned actions on one process; deleting goes back to the list. */
export function useProcessActions(p: ProcessDetail) {
  const navigate = useNavigate();
  const enable = useReasonedMutation(
    useEnableProcess(),
    (v: { id: string; enabled: boolean }) =>
      enableProcessPrompt(p.name, v.enabled, enableConsequence(p, v.enabled)),
    { successMessage: (r) => `${p.name} ${r.enabled ? 'enabled' : 'disabled'}` },
  );
  const runNow = useReasonedMutation(useRunProcess(), runProcessPrompt(p.name), {
    successMessage: (r) => runStartedMessage('Run', r),
  });
  const remove = useReasonedMutation(
    useDeleteProcess(),
    deleteProcessPrompt(p.name, deleteConsequence(p)),
    { successMessage: `${p.name} deleted` },
  );
  const reset = useReasonedMutation(useResetBreaker(), resetBreakerPrompt(p.name), {
    successMessage: 'Breaker reset',
  });
  return {
    setEnabled: (enabled: boolean) => void enable.run({ id: p.id, enabled }),
    runNow: {
      pending: runNow.pending,
      run: () => void runNow.run({ id: p.id }),
    } satisfies ProcessAction,
    remove: {
      pending: remove.pending,
      // `run` resolves null when cancelled or refused; a 204 resolves undefined.
      run: () =>
        void remove.run({ id: p.id }).then((r) => {
          if (r !== null) void navigate('/processes');
        }),
    } satisfies ProcessAction,
    resetBreaker: {
      pending: reset.pending,
      run: () => void reset.run({ id: p.id }),
    } satisfies ProcessAction,
  };
}

export type ProcessActions = ReturnType<typeof useProcessActions>;
