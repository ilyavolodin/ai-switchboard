import type { IconName } from '../components/Icon.js';

/** The left rail, in the IA's order. */
export const NAV_ITEMS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Board', icon: 'board', end: true },
  { to: '/processes', label: 'Processes', icon: 'processes' },
  { to: '/sources', label: 'Sources', icon: 'sources' },
  { to: '/destinations', label: 'Destinations', icon: 'destinations' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/approvals', label: 'Approvals', icon: 'approvals' },
  { to: '/plugins', label: 'Plugins', icon: 'plugins' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

/** The route `handle` every screen route sets; the top bar shows `title`. */
export interface RouteHandle {
  title: string;
}

/** Narrows an unknown route handle. */
export function isRouteHandle(h: unknown): h is RouteHandle {
  return (
    typeof h === 'object' && h !== null && typeof (h as { title?: unknown }).title === 'string'
  );
}
