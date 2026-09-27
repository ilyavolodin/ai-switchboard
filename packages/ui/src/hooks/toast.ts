import type { StatusTone } from '@ai-switchboard/core/contract';
import { createContext, useContext } from 'react';

/** One toast message. */
export interface ToastInput {
  tone?: StatusTone | 'info';
  title: string;
  detail?: string;
}

/** Provided by `<ToastProvider>`; a no-op outside it. */
export const ToastContext = createContext<(t: ToastInput) => void>(() => undefined);

/** Shows a transient message: `toast({ tone: 'ok', title: 'Breaker reset' })`. */
export function useToast(): (t: ToastInput) => void {
  return useContext(ToastContext);
}
