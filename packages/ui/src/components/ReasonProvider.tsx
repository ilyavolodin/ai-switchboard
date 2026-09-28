import { type ReactNode, useCallback, useRef, useState } from 'react';

import { type AskReason, ReasonContext, type ReasonPromptOptions } from '../hooks/reason.js';
import { ReasonDialog } from './ReasonDialog.js';

/**
 * Hosts the one app-wide reason prompt. `useReasonPrompt()` / `useReasonedMutation()` open it and
 * await the typed reason.
 */
export function ReasonProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ReasonPromptOptions | null>(null);
  const resolver = useRef<((reason: string | null) => void) | null>(null);

  const ask = useCallback<AskReason>((options) => {
    resolver.current?.(null);
    setRequest(options);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (reason: string | null) => {
    resolver.current?.(reason);
    resolver.current = null;
    setRequest(null);
  };

  return (
    <ReasonContext.Provider value={ask}>
      {children}
      <ReasonDialog
        open={request != null}
        title={request?.title ?? ''}
        consequence={request?.consequence}
        confirmLabel={request?.confirmLabel ?? 'Confirm'}
        danger={request?.danger}
        placeholder={request?.placeholder}
        optional={request?.optional}
        onConfirm={(reason) => {
          settle(reason);
        }}
        onCancel={() => {
          settle(null);
        }}
      />
    </ReasonContext.Provider>
  );
}
