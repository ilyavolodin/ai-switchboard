import { useEffect, useRef } from 'react';
import { type Blocker, useBlocker } from 'react-router';

export interface LeaveGuard {
  blocker: Blocker;
  /**
   * Call right before navigating away after a successful save: the saved state has not re-rendered
   * yet, so the form still looks dirty.
   */
  allowNextNavigation: () => void;
}

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
