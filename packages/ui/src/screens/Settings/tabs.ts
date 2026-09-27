/** The Settings tabs, in rail order; each is a URL segment under `/settings`. */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'sign-in', label: 'Sign-in' },
  { id: 'users', label: 'Users' },
  { id: 'tokens', label: 'API tokens' },
  { id: 'notifiers', label: 'Notifiers' },
  { id: 'secret-providers', label: 'Secret providers' },
  { id: 'retention', label: 'Retention' },
  { id: 'export', label: 'Export' },
  { id: 'about', label: 'About' },
  { id: 'audit', label: 'Audit log' },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/** The tab for a URL segment (`undefined` → General); `null` for an unknown segment. */
export function settingsTab(segment: string | undefined): SettingsTabId | null {
  if (segment == null || segment === '') return 'general';
  return SETTINGS_TABS.find((t) => t.id === segment)?.id ?? null;
}

/** The link for a tab: General is `/settings` itself. */
export function settingsHref(id: SettingsTabId): string {
  return id === 'general' ? '/settings' : `/settings/${id}`;
}
