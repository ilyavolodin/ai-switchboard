/**
 * Plugin-declared type icons (since SDK 1.3). A source, destination, notifier or secret provider
 * type may set `icon` to either the name of one of the UI's built-in icons (`ICON_NAMES`) or a
 * `data:image/svg+xml;base64,…` URI of at most `MAX_ICON_DATA_URI_LENGTH` characters. The UI
 * renders a data URI through `<img>`, never as inline markup, so an SVG cannot run script.
 */

/** The UI's built-in icon set, by name. */
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

/** One of the UI's built-in icon names. */
export type IconName = (typeof ICON_NAMES)[number];

/** The only data URI prefix a plugin icon may use. */
export const ICON_DATA_URI_PREFIX = 'data:image/svg+xml;base64,';

/** The longest accepted data URI, in characters (8 KB). */
export const MAX_ICON_DATA_URI_LENGTH = 8192;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True for a built-in icon name. */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && (ICON_NAMES as readonly string[]).includes(value);
}

/**
 * Check a declared `icon`. Returns `null` when it is acceptable (a built-in name, or an SVG data
 * URI within the size limit whose payload decodes to an `<svg>` document), else the reason.
 */
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
