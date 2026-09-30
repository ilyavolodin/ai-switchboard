import type { InstanceKind } from '@ai-switchboard/core/domain';

const at = (base: string, id: string, tab?: string) =>
  `${base}/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;

export function processHref(id: string, tab?: string): string {
  return at('/processes', id, tab);
}

export function sourceHref(id: string, tab?: string): string {
  return at('/sources', id, tab);
}

export function destinationHref(id: string, tab?: string): string {
  return at('/destinations', id, tab);
}

export function traceHref(query: string): string {
  return `/activity/trace/${encodeURIComponent(query)}`;
}

/** Notifiers and secret providers have no page of their own: their Settings tab. */
export function instanceHref(kind: InstanceKind, id: string): string {
  switch (kind) {
    case 'source':
      return sourceHref(id);
    case 'destination':
      return destinationHref(id);
    case 'notifier':
      return '/settings/notifiers';
    case 'secret_provider':
      return '/settings/secret-providers';
  }
}
