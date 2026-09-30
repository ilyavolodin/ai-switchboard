/** Returned by a visitor to keep a node as it is (descending into it when it is a container). */
export const KEEP: unique symbol = Symbol('keep');

/** `a.b[0].c`; the root is `''`. */
export type JsonPath = string;

function childPath(path: JsonPath, key: string | number): JsonPath {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * Visits every node, parents before children. Returning `true` skips the node's children (the
 * visitor handled it as a whole, like a secret marker object).
 */
export function walkJson(
  value: unknown,
  visit: (node: unknown, path: JsonPath) => unknown,
  path: JsonPath = '',
): void {
  if (visit(value, path) === true || !isContainer(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      walkJson(item, visit, childPath(path, i));
    });
    return;
  }
  for (const [k, v] of Object.entries(value)) walkJson(v, visit, childPath(path, k));
}

/**
 * A copy of `value` with each node the visitor returns a replacement for replaced (not descended
 * into). Returning `KEEP` keeps the node and descends into containers.
 */
export function mapJson(
  value: unknown,
  visit: (node: unknown, path: JsonPath) => unknown,
  path: JsonPath = '',
): unknown {
  const replaced = visit(value, path);
  if (replaced !== KEEP) return replaced;
  if (!isContainer(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item: unknown, i) => mapJson(item, visit, childPath(path, i)));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = mapJson(v, visit, childPath(path, k));
  return out;
}

/** `mapJson` with an async visitor; siblings are visited in parallel. */
export async function mapJsonAsync(
  value: unknown,
  visit: (node: unknown, path: JsonPath) => unknown,
  path: JsonPath = '',
): Promise<unknown> {
  const replaced = await visit(value, path);
  if (replaced !== KEEP) return replaced;
  if (!isContainer(value)) return value;
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item: unknown, i) => mapJsonAsync(item, visit, childPath(path, i))),
    );
  }
  const entries = await Promise.all(
    Object.entries(value).map(
      async ([k, v]) => [k, await mapJsonAsync(v, visit, childPath(path, k))] as const,
    ),
  );
  return Object.fromEntries(entries);
}
