/** Pure helpers for the Plugins screen. */
import type { Capabilities, PluginKind } from '@ai-switchboard/core/contract';

/** "@acme/switchboard-source-jira@^1" → { package: "@acme/switchboard-source-jira", range: "^1" }. */
export function parsePackageSpec(input: string): { package: string; range?: string } {
  const text = input.trim();
  const at = text.lastIndexOf('@');
  if (at > 0) {
    const range = text.slice(at + 1).trim();
    return range ? { package: text.slice(0, at), range } : { package: text.slice(0, at) };
  }
  return { package: text };
}

/** A plausible npm package name (scoped or not). */
export function isPackageName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

/** "source", "destination", "notifier", "secret provider". */
export function kindLabel(kind: PluginKind): string {
  return kind === 'secret_provider' ? 'secret provider' : kind;
}

/** Declared network hosts, or a word for none / any. */
export function networkText(c: Capabilities): string {
  const hosts = c.network ?? [];
  if (hosts.length === 0) return 'no network';
  if (hosts.includes('*')) return 'any host';
  return hosts.join(', ');
}

/** Declared secret names, or "no secrets". */
export function secretsText(c: Capabilities): string {
  const names = c.secrets ?? [];
  return names.length === 0 ? 'no secrets' : names.join(', ');
}
