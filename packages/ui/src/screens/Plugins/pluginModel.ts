import type { Capabilities, PluginKind } from '@ai-switchboard/core/contract';

export function parsePackageSpec(input: string): { package: string; range?: string } {
  const text = input.trim();
  const at = text.lastIndexOf('@');
  if (at > 0) {
    const range = text.slice(at + 1).trim();
    return range ? { package: text.slice(0, at), range } : { package: text.slice(0, at) };
  }
  return { package: text };
}

export function isPackageName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

export function kindLabel(kind: PluginKind): string {
  return kind === 'secret_provider' ? 'secret provider' : kind;
}

export function networkText(c: Capabilities): string {
  const hosts = c.network ?? [];
  if (hosts.length === 0) return 'no network';
  if (hosts.includes('*')) return 'any host';
  return hosts.join(', ');
}

export function secretsText(c: Capabilities): string {
  const names = c.secrets ?? [];
  return names.length === 0 ? 'no secrets' : names.join(', ');
}
