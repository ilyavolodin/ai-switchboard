import type { ReactNode } from 'react';

import { ReasonDialog } from './ReasonDialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  /** "Disable Autofix?" */
  title: ReactNode;
  /**
   * Required: the sentence naming the effect on the fleet ("Disabling Autofix stops event runs;
   * its daily sweep still runs. The open batch for LOL-1719 will be dropped.").
   */
  consequence: ReactNode;
  /** Repeats the verb: "Disable Autofix". */
  confirmLabel: string;
  /** Coral confirm (default true: fleet-affecting actions are destructive by nature). */
  danger?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * The confirm dialog for fleet-affecting actions: names the effect, asks for a reason, repeats
 * the verb on the button. A `ReasonDialog` whose consequence sentence is mandatory.
 */
export function ConfirmDialog({ danger = true, ...props }: ConfirmDialogProps) {
  return <ReasonDialog danger={danger} {...props} />;
}
