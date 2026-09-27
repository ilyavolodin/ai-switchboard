import type { Blocker } from 'react-router';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';

/** The "Leave without saving?" prompt for a blocked navigation (see `useLeaveGuard`). */
export function LeaveGuardDialog({ blocker, summary }: { blocker: Blocker; summary: string }) {
  const stay = () => {
    blocker.reset?.();
  };
  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onClose={stay}
      title="Leave without saving?"
      footer={
        <>
          <Button variant="ghost" onClick={stay}>
            Keep editing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              blocker.proceed?.();
            }}
          >
            Leave without saving
          </Button>
        </>
      }
    >
      <p>{summary} will be lost. Nothing has been saved or audited.</p>
    </Dialog>
  );
}
