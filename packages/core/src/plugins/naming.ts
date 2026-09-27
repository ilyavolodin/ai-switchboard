import type { PluginKind } from '@ai-switchboard/sdk';

/**
 * The naming convention that makes a plugin package discoverable from the UI's "Browse npm":
 *
 * - `ai-switchboard-{kind}-{name}`
 * - `@scope/ai-switchboard-{kind}-{name}`
 * - `@ai-switchboard/{kind}-{name}` (the project's own scope)
 *
 * where `{kind}` is one of {@link PLUGIN_NAME_KINDS}. Any package with a `switchboard` field can
 * still be installed by name; the convention only decides what search shows.
 */
export const PLUGIN_NAME_KINDS = ['source', 'executor', 'notifier', 'secrets'] as const;

/** The `{kind}` segment of a discoverable package name. */
export type PluginNameKind = (typeof PLUGIN_NAME_KINDS)[number];

/** The npm keyword every plugin package carries (`"keywords": ["switchboard-plugin"]`). */
export const PLUGIN_KEYWORD = 'switchboard-plugin';

/** The unscoped (or third-party scoped) name prefix: `ai-switchboard-`. */
export const PLUGIN_NAME_PREFIX = 'ai-switchboard-';

/** The project's own npm scope. */
export const PLUGIN_OWN_SCOPE = '@ai-switchboard';

const SEGMENT = '[a-z0-9][a-z0-9._-]*';

/**
 * The convention as one regular expression. Groups: 1 = the kind, 2 = the name.
 * `@ai-switchboard/sdk` and `@ai-switchboard/core` do not match: they have no kind segment.
 */
export const PLUGIN_NAME_PATTERN = new RegExp(
  `^(?:${PLUGIN_OWN_SCOPE}/|(?:@${SEGMENT}/)?${PLUGIN_NAME_PREFIX})(${PLUGIN_NAME_KINDS.join('|')})-(${SEGMENT})$`,
);

/** A package name read against the convention. */
export interface PluginPackageName {
  kind: PluginNameKind;
  /** The `{name}` segment, e.g. `jira` for `@acme/ai-switchboard-source-jira`. */
  name: string;
}

/** Reads `{kind}` and `{name}` from a discoverable package name; `null` when it does not match. */
export function parsePluginPackageName(pkg: string): PluginPackageName | null {
  const m = PLUGIN_NAME_PATTERN.exec(pkg.trim().toLowerCase());
  if (!m) return null;
  const kind = m[1] as PluginNameKind | undefined;
  const name = m[2];
  return kind && name ? { kind, name } : null;
}

/** True when `pkg` follows the convention (and, when `kind` is given, names that kind). */
export function isDiscoverablePluginName(pkg: string, kind?: PluginNameKind): boolean {
  const parsed = parsePluginPackageName(pkg);
  return parsed !== null && (kind === undefined || parsed.kind === kind);
}

/** The instance kind a name kind contributes (`secrets` → `secret_provider`). */
export function pluginKindOf(kind: PluginNameKind): PluginKind {
  return kind === 'secrets' ? 'secret_provider' : kind;
}

/** True for one of {@link PLUGIN_NAME_KINDS}. */
export function isPluginNameKind(value: unknown): value is PluginNameKind {
  return typeof value === 'string' && (PLUGIN_NAME_KINDS as readonly string[]).includes(value);
}
