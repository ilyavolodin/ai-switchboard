import { useSyncExternalStore } from 'react';

/** Light is the default; dark is a per-viewer preference. */
export type Theme = 'light' | 'dark';

const KEY = 'switchboard.theme';
const listeners = new Set<() => void>();

/** The stored theme, `light` when nothing is stored or storage is unavailable. */
export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Sets `data-theme` on <html>. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Stores and applies a theme, notifying `useTheme` subscribers. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode or blocked storage: the theme still applies for this page view.
  }
  applyTheme(theme);
  listeners.forEach((l) => {
    l();
  });
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active theme and a toggle. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, (): Theme => 'light');
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
