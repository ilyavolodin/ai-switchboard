/**
 * Dotted paths into a delivery, for the quick and mapped modes: `body.issue.id`,
 * `headers.x-github-event`, `query.env`, `body.labels.0`, `body.labels.name`. Pure: no I/O.
 */

/** What every path reads from: the parsed body, the lower-cased headers and the query. */
export interface DeliveryView {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** The roots a path may start with. */
export const PATH_ROOTS = ['body', 'headers', 'query'] as const;

/** The JSON Schema `pattern` a path setting must match. */
export const PATH_PATTERN = '^(body|headers|query)(\\.[^.\\s]+)*$';

const PATH_RE = new RegExp(PATH_PATTERN);

/** True when `path` is a well-formed delivery path. */
export function isDeliveryPath(path: string): boolean {
  return PATH_RE.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Read `path` from the delivery. Header names are matched case-insensitively. Returns
 * `undefined` for a malformed path or a missing value.
 */
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

/** A value as it appears in a note: short, one line. */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** A scalar as an id-like string (`42` → `'42'`), or undefined for anything else or empty. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}
