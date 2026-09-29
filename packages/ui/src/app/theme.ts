import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'switchboard.theme';
const listeners = new Set<() => void>();

export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

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

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, (): Theme => 'light');
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
