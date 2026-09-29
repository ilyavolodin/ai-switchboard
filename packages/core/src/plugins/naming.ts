import type { PluginKind } from '@ai-switchboard/sdk';

/**
 * Package names `ai-switchboard-{kind}-{name}`, `@scope/ai-switchboard-{kind}-{name}` and
 * `@ai-switchboard/{kind}-{name}` are discoverable in "Browse npm". Any package with a
 * `switchboard` field can still be installed by name; the convention only decides what search shows.
 */
export const PLUGIN_NAME_KINDS = ['source', 'destination', 'notifier', 'secrets'] as const;

export type PluginNameKind = (typeof PLUGIN_NAME_KINDS)[number];

export const PLUGIN_KEYWORD = 'switchboard-plugin';

export const PLUGIN_NAME_PREFIX = 'ai-switchboard-';

export const PLUGIN_OWN_SCOPE = '@ai-switchboard';

const SEGMENT = '[a-z0-9][a-z0-9._-]*';

/**
 * Groups: 1 = the kind, 2 = the name. `@ai-switchboard/sdk` and `@ai-switchboard/core` do not
 * match: they have no kind segment.
 */
export const PLUGIN_NAME_PATTERN = new RegExp(
  `^(?:${PLUGIN_OWN_SCOPE}/|(?:@${SEGMENT}/)?${PLUGIN_NAME_PREFIX})(${PLUGIN_NAME_KINDS.join('|')})-(${SEGMENT})$`,
);

export interface PluginPackageName {
  kind: PluginNameKind;
  name: string;
}

export function parsePluginPackageName(pkg: string): PluginPackageName | null {
  const m = PLUGIN_NAME_PATTERN.exec(pkg.trim().toLowerCase());
  if (!m) return null;
  const kind = m[1] as PluginNameKind | undefined;
  const name = m[2];
  return kind && name ? { kind, name } : null;
}

export function isDiscoverablePluginName(pkg: string, kind?: PluginNameKind): boolean {
  const parsed = parsePluginPackageName(pkg);
  return parsed !== null && (kind === undefined || parsed.kind === kind);
}

export function pluginKindOf(kind: PluginNameKind): PluginKind {
  return kind === 'secrets' ? 'secret_provider' : kind;
}

export function isPluginNameKind(value: unknown): value is PluginNameKind {
  return typeof value === 'string' && (PLUGIN_NAME_KINDS as readonly string[]).includes(value);
}
