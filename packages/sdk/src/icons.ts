// The UI renders a data URI icon through `<img>`, never as inline markup, so an SVG cannot run script.

export const ICON_NAMES = [
  'board',
  'processes',
  'sources',
  'destinations',
  'activity',
  'approvals',
  'plugins',
  'settings',
  'search',
  'back',
  'chevron-right',
  'chevron-down',
  'chevron-up',
  'external',
  'copy',
  'close',
  'check',
  'warning',
  'info',
  'pause',
  'refresh',
  'clock',
  'event',
  'manual',
  'key',
  'lock',
  'plus',
  'trash',
  'edit',
  'filter',
  'sun',
  'moon',
  'menu',
  'logout',
  'more',
  'play',
  'gate',
  'budget',
  'webhook',
  'link',
  'artifact',
  'pr',
  'issue',
  'alert',
  'run',
  'user',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const ICON_DATA_URI_PREFIX = 'data:image/svg+xml;base64,';

/** In characters. */
export const MAX_ICON_DATA_URI_LENGTH = 8192;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && (ICON_NAMES as readonly string[]).includes(value);
}

/** `null` when the icon is acceptable, else the reason. */
export function iconProblem(icon: unknown): string | null {
  if (typeof icon !== 'string' || icon === '') return 'icon must be a non-empty string';
  if (isIconName(icon)) return null;
  if (!icon.startsWith('data:')) {
    return `icon "${icon}" is neither a built-in icon name (ICON_NAMES) nor a data URI`;
  }
  if (!icon.startsWith(ICON_DATA_URI_PREFIX)) {
    return `icon data URI must start with "${ICON_DATA_URI_PREFIX}" (SVG only, base64)`;
  }
  if (icon.length > MAX_ICON_DATA_URI_LENGTH) {
    return `icon data URI is ${icon.length} characters; the limit is ${MAX_ICON_DATA_URI_LENGTH}`;
  }
  const payload = icon.slice(ICON_DATA_URI_PREFIX.length);
  if (!BASE64.test(payload) || payload.length % 4 !== 0) return 'icon data URI is not valid base64';
  let text: string;
  try {
    text = atob(payload);
  } catch {
    return 'icon data URI is not valid base64';
  }
  if (!/<svg[\s>]/i.test(text)) return 'icon data URI does not contain an <svg> document';
  return null;
}
