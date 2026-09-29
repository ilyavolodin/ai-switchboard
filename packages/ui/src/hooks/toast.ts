import type { StatusTone } from '@ai-switchboard/core/contract';
import { createContext, useContext } from 'react';

export interface ToastInput {
  tone?: StatusTone | 'info';
  title: string;
  detail?: string;
}

/** A no-op outside `<ToastProvider>`. */
export const ToastContext = createContext<(t: ToastInput) => void>(() => undefined);

export function useToast(): (t: ToastInput) => void {
  return useContext(ToastContext);
}
