import type { Reasoned } from '@ai-switchboard/core/contract';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useReasonedMutation } from '../../hooks/reason.js';
import { type ProcessRef, useInUseRefusal } from '../../hooks/useInUseRefusal.js';
import { InUseBanner } from './InUseBanner.js';

export interface InstanceDeletion {
  /** Resolves `null` when it did not happen (cancelled, refused, failed). */
  run: () => Promise<unknown>;
  pending: boolean;
  /** The "still in use" banner while a delete is refused. */
  blocked: ReactNode;
}

export interface InstanceDeleteInput<D> {
  noun: 'source' | 'destination';
  entity: { id: string; name: string; processes: ProcessRef[] };
  mutation: UseMutationResult<D, Error, Reasoned & { id: string }>;
  consequence: string;
}

/**
 * Deleting a source or destination that processes still use is refused: say why at once instead of
 * asking the server, and show the server's own refusal the same way.
 */
export function useInstanceDelete<D>({
  noun,
  entity,
  mutation,
  consequence,
}: InstanceDeleteInput<D>): InstanceDeletion {
  const inUse = useInUseRefusal();
  const remove = useReasonedMutation(
    mutation,
    {
      title: `Delete ${entity.name}?`,
      consequence,
      confirmLabel: `Delete ${noun}`,
      danger: true,
    },
    { successMessage: `${entity.name} deleted`, onError: inUse.onError },
  );
  return {
    run: () => {
      if (entity.processes.length > 0) {
        inUse.block(entity.processes);
        return Promise.resolve(null);
      }
      return remove.run({ id: entity.id });
    },
    pending: remove.pending,
    blocked: inUse.usedBy && (
      <InUseBanner
        name={entity.name}
        kind={noun}
        processes={inUse.usedBy}
        onDismiss={inUse.dismiss}
      />
    ),
  };
}
