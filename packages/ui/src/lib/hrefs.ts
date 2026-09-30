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
