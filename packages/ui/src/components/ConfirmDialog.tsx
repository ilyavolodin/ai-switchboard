import type { ReactNode } from 'react';

import { ReasonDialog } from './ReasonDialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** The sentence naming the effect on the fleet. */
  consequence: ReactNode;
  confirmLabel: string;
  /** Defaults to true: fleet-affecting actions are destructive by nature. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** A `ReasonDialog` for fleet-affecting actions, whose consequence sentence is mandatory. */
export function ConfirmDialog({ danger = true, ...props }: ConfirmDialogProps) {
  return <ReasonDialog danger={danger} {...props} />;
}
