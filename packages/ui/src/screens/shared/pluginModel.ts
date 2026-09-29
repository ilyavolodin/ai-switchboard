import type { Capabilities, PluginKind, PluginSummary } from '@ai-switchboard/core/contract';

import type { ReasonPromptOptions } from '../../hooks/reason.js';

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

export interface PluginRequest {
  package: string;
  range?: string;
}

/** The Plugins page "adds"; a form that installs on the way to a new instance "installs". */
export type InstallVerb = 'Add' | 'Install';

export function installPluginPrompt(
  v: PluginRequest,
  verb: InstallVerb,
  afterwards: string,
): ReasonPromptOptions {
  return {
    title: `${verb} ${v.package}${v.range ? `@${v.range}` : ''}?`,
    consequence: `The package is installed, pinned in plugins.lock.json and loaded now; every replica installs it within a minute. ${afterwards}`,
    confirmLabel: `${verb} plugin`,
  };
}

export function installedMessage(added: Pick<PluginSummary, 'pendingRestart'>, verb: InstallVerb) {
  const done = verb === 'Add' ? 'Added' : 'Installed';
  return added.pendingRestart ? `${done} · restart to apply` : `${done} · ready to use`;
}

export type InstallOutcome =
  { kind: 'continue'; typeIds: string[] } | { kind: 'note'; note: string };

/** What a form that installed a plugin on the way to a new `kind` instance does next. */
export function installOutcome(
  added: Pick<PluginSummary, 'name' | 'pendingRestart' | 'statusMessage' | 'types'>,
  kind: PluginKind,
): InstallOutcome {
  if (added.pendingRestart) {
    return {
      kind: 'note',
      note: `${added.name} is installed; restart Switchboard to load this version.`,
    };
  }
  const typeIds = added.types.filter((t) => t.kind === kind).map((t) => t.typeId);
  if (typeIds.length === 0) {
    return {
      kind: 'note',
      note: `${added.name} is installed but contributes no ${kindLabel(kind)} type${added.statusMessage ? `: ${added.statusMessage}` : '.'}`,
    };
  }
  return { kind: 'continue', typeIds };
}
