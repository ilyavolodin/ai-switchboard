import type { UseMutationResult } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { errorMessage } from '../api/client.js';
import { useToast } from './toast.js';

/** What the reason prompt shows. */
export interface ReasonPromptOptions {
  /** "Reset the Autofix breaker?" */
  title: string;
  /** The sentence naming the consequence: "Event runs resume immediately; …". */
  consequence?: ReactNode;
  /** The confirm button repeats the verb: "Reset breaker". */
  confirmLabel: string;
  /** Coral confirm button for destructive or fleet-affecting actions. */
  danger?: boolean;
  placeholder?: string;
}

/** Opens the reason dialog; resolves to the reason, or `null` when cancelled. */
export type AskReason = (options: ReasonPromptOptions) => Promise<string | null>;

/** Provided by `<ReasonProvider>`. */
export const ReasonContext = createContext<AskReason | null>(null);

/** The `ask` function of the app-wide reason prompt. */
export function useReasonPrompt(): AskReason {
  const ask = useContext(ReasonContext);
  if (!ask) throw new Error('useReasonPrompt needs a <ReasonProvider> ancestor');
  return ask;
}

/**
 * Wraps a reason-carrying mutation so that `run(vars)` first asks for a one-line reason, then
 * sends `{ ...vars, reason }`. Every state-changing action in the UI goes through this.
 *
 *   const reset = useReasonedMutation(useResetBreaker(), (v) => ({
 *     title: 'Reset the Autofix breaker?', confirmLabel: 'Reset breaker', ... }));
 *   <Button onClick={() => reset.run({ id })}>Reset</Button>
 */
export function useReasonedMutation<TData, TVars extends { reason: string }>(
  mutation: UseMutationResult<TData, Error, TVars>,
  prompt: ReasonPromptOptions | ((vars: Omit<TVars, 'reason'>) => ReasonPromptOptions),
  options: { successMessage?: string | ((data: TData) => string) } = {},
) {
  const ask = useReasonPrompt();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const { mutateAsync } = mutation;
  // Callers pass the prompt and options inline; reading them through a ref keeps `run` stable.
  const latest = useRef({ prompt, options });
  useEffect(() => {
    latest.current = { prompt, options };
  });

  const run = useCallback(
    async (vars: Omit<TVars, 'reason'>): Promise<TData | null> => {
      const { prompt: p, options: o } = latest.current;
      const reason = await ask(typeof p === 'function' ? p(vars) : p);
      if (reason == null) return null;
      setPending(true);
      try {
        const data = await mutateAsync({ ...vars, reason } as TVars);
        const msg =
          typeof o.successMessage === 'function' ? o.successMessage(data) : o.successMessage;
        if (msg) toast({ tone: 'ok', title: msg });
        return data;
      } catch (e) {
        toast({ tone: 'error', title: 'That did not work', detail: errorMessage(e) });
        return null;
      } finally {
        setPending(false);
      }
    },
    [ask, mutateAsync, toast],
  );

  return { run, pending: pending || mutation.isPending, mutation };
}
