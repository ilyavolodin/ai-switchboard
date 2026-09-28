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
import { useSession } from '../app/session.js';
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
  /**
   * Set by `useReasonPrompt` when the installation makes reasons optional: the dialog asks for an
   * optional note instead of a required reason.
   */
  optional?: boolean;
}

/** Opens the reason dialog; resolves to the reason, or `null` when cancelled. */
export type AskReason = (options: ReasonPromptOptions) => Promise<string | null>;

/** Provided by `<ReasonProvider>`. */
export const ReasonContext = createContext<AskReason | null>(null);

/**
 * The `ask` function of the app-wide reason prompt. When the installation does not require
 * reasons (`Session.requireReasons`), it resolves to an empty reason at once (the server audits
 * "(no reason given)"); a `danger` action still opens the dialog as a confirmation, with the
 * reason optional.
 */
export function useReasonPrompt(): AskReason {
  const ask = useContext(ReasonContext);
  const { requireReasons } = useSession();
  const prompt = useCallback<AskReason>(
    (options) => {
      if (!ask)
        return Promise.reject(new Error('useReasonPrompt needs a <ReasonProvider> ancestor'));
      if (requireReasons) return ask(options);
      if (!options.danger) return Promise.resolve('');
      return ask({ ...options, optional: true });
    },
    [ask, requireReasons],
  );
  if (!ask) throw new Error('useReasonPrompt needs a <ReasonProvider> ancestor');
  return prompt;
}

/**
 * Wraps a reason-carrying mutation so that `run(vars)` first asks for a one-line reason, then
 * sends `{ ...vars, reason }`. Every state-changing action in the UI goes through this. With
 * reasons optional (Settings › General), non-danger actions skip the prompt and send `reason: ''`.
 *
 *   const reset = useReasonedMutation(useResetBreaker(), (v) => ({
 *     title: 'Reset the Autofix breaker?', confirmLabel: 'Reset breaker', ... }));
 *   <Button onClick={() => reset.run({ id })}>Reset</Button>
 */
export function useReasonedMutation<TData, TVars extends { reason: string }>(
  mutation: UseMutationResult<TData, Error, TVars>,
  prompt: ReasonPromptOptions | ((vars: Omit<TVars, 'reason'>) => ReasonPromptOptions),
  options: {
    successMessage?: string | ((data: TData) => string);
    /** Return true when the caller shows the error itself (no error toast). */
    onError?: (e: unknown) => boolean;
  } = {},
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
        if (!o.onError?.(e)) {
          toast({ tone: 'error', title: 'That did not work', detail: errorMessage(e) });
        }
        return null;
      } finally {
        setPending(false);
      }
    },
    [ask, mutateAsync, toast],
  );

  return { run, pending: pending || mutation.isPending, mutation };
}
