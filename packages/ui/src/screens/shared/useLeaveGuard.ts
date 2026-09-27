import { useEffect, useRef } from 'react';
import { type Blocker, useBlocker } from 'react-router';

/** What `useLeaveGuard` hands the screen. */
export interface LeaveGuard {
  /** The router's blocker: `state === 'blocked'` while the leave prompt should show. */
  blocker: Blocker;
  /**
   * Lets the next navigation through without asking. Call it right before navigating away
   * after a successful save: the saved state has not re-rendered yet, so the form still looks
   * dirty at that moment.
   */
  allowNextNavigation: () => void;
}

/**
 * Guards unsaved edits: while `dirty`, an in-app navigation to another path is blocked (render
 * `<LeaveGuardDialog>` to ask) and closing or reloading the tab asks the browser's own question.
 */
export function useLeaveGuard(dirty: boolean): LeaveGuard {
  const bypass = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current) {
      bypass.current = false;
      return false;
    }
    return dirty && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);

  return {
    blocker,
    allowNextNavigation: () => {
      bypass.current = true;
    },
  };
}
