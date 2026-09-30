import type { EnableRequest, Reasoned } from '@ai-switchboard/core/contract';
import type { UseMutationResult } from '@tanstack/react-query';

import { type ReasonPromptOptions, useReasonedMutation } from '../../hooks/reason.js';
import { reloadedMessage, reloadPrompt } from './actionPrompts.js';

type IdVars<B> = B & { id: string };

export interface InstanceActionsInput<E, R> {
  noun: 'source' | 'destination';
  entity: { id: string; name: string };
  enable: UseMutationResult<E, Error, IdVars<EnableRequest>>;
  reload: UseMutationResult<R, Error, IdVars<Reasoned>>;
  enablePrompt: (enabled: boolean) => ReasonPromptOptions;
}

export interface InstanceActions {
  setEnabled: (enabled: boolean) => void;
  reload: () => void;
  reloading: boolean;
}

/** The enable toggle and Reload that every source and destination offers, with their prompts. */
export function useInstanceActions<E, R>({
  noun,
  entity,
  enable,
  reload,
  enablePrompt,
}: InstanceActionsInput<E, R>): InstanceActions {
  const toggle = useReasonedMutation(enable, (v: { enabled: boolean }) => enablePrompt(v.enabled));
  const reloader = useReasonedMutation(reload, reloadPrompt(noun, entity.name), {
    successMessage: reloadedMessage(noun),
  });
  return {
    setEnabled: (enabled) => void toggle.run({ id: entity.id, enabled }),
    reload: () => void reloader.run({ id: entity.id }),
    reloading: reloader.pending,
  };
}
