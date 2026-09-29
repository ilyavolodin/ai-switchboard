import { isRecord } from '@ai-switchboard/sdk/json';

/**
 * Dotted paths into a delivery, for the quick and mapped modes: `body.issue.id`,
 * `headers.x-github-event`, `query.env`, `body.labels.0`, `body.labels.name`. Pure: no I/O.
 */

/** Header names are lower-cased. */
export interface DeliveryView {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export const PATH_ROOTS = ['body', 'headers', 'query'] as const;

export const PATH_PATTERN = '^(body|headers|query)(\\.[^.\\s]+)*$';

const PATH_RE = new RegExp(PATH_PATTERN);

export function isDeliveryPath(path: string): boolean {
  return PATH_RE.test(path);
}

function step(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment)) return value[Number(segment)];
    // A name on a list reads it from every element: `body.labels.name` → ['bug', 'p1'].
    const out = value.flatMap((item: unknown) => {
      const v = step(item, segment);
      if (v === undefined) return [];
      return Array.isArray(v) ? (v as unknown[]) : [v];
    });
    return out.length > 0 ? out : undefined;
  }
  if (isRecord(value)) return Object.hasOwn(value, segment) ? value[segment] : undefined;
  return undefined;
}

/** Header names match case-insensitively. `undefined` for a malformed path or a missing value. */
export function readPath(view: DeliveryView, path: string): unknown {
  const trimmed = path.trim();
  if (!isDeliveryPath(trimmed)) return undefined;
  const [root, ...segments] = trimmed.split('.');
  let value: unknown = root === 'body' ? view.body : root === 'headers' ? view.headers : view.query;
  for (const [i, segment] of segments.entries()) {
    value = step(value, root === 'headers' && i === 0 ? segment.toLowerCase() : segment);
    if (value === undefined) return undefined;
  }
  return value === null ? undefined : value;
}

export function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}
