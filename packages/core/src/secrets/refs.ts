/**
 * `secret://<provider>/<name>` references. Settings store references, never values; the plugin
 * host resolves them through secret-provider instances when it builds a live object.
 */

export const SECRET_SCHEME = 'secret://';

export interface SecretRef {
  provider: string;
  name: string;
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_SCHEME);
}

export function parseSecretRef(value: string): SecretRef | null {
  if (!value.startsWith(SECRET_SCHEME)) return null;
  const rest = value.slice(SECRET_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

export function formatSecretRef(ref: SecretRef): string {
  return `${SECRET_SCHEME}${ref.provider}/${ref.name}`;
}

/** Every `secret://` string anywhere in a settings object, with its dotted path. */
export function collectSecretRefs(value: unknown, path = ''): { path: string; ref: string }[] {
  if (isSecretRef(value)) return [{ path, ref: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectSecretRefs(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      collectSecretRefs(v, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

export type SecretLookup = (ref: string) => Promise<string>;

/** Deep-copy `value`, replacing every secret reference with its resolved value. */
export async function resolveSecretRefs(
  value: unknown,
  lookup: SecretLookup,
): Promise<{ value: unknown; secrets: string[] }> {
  const secrets: string[] = [];
  const walk = async (v: unknown): Promise<unknown> => {
    if (isSecretRef(v)) {
      const resolved = await lookup(v);
      secrets.push(resolved);
      return resolved;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = await walk(inner);
      return out;
    }
    return v;
  };
  return { value: await walk(value), secrets };
}

/**
 * Settings fields marked `x-secret` must hold a reference (or be empty), never a literal. Returns
 * the offending paths so the API can reject a save that would store a secret value in Postgres.
 */
export function literalSecretFields(
  secretPaths: string[],
  settings: Record<string, unknown>,
): string[] {
  const bad: string[] = [];
  for (const path of secretPaths) {
    let cur: unknown = settings;
    for (const key of path.split('.')) {
      cur =
        cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    }
    if (typeof cur === 'string' && cur !== '' && !isSecretRef(cur)) bad.push(path);
  }
  return bad;
}

export const REDACTED = '[redacted]';

/**
 * Deep-copy `value` with every occurrence of a secret value inside a string replaced by
 * `[redacted]`. Used on what a backend sends back (results, error messages) before it is stored,
 * since a backend may echo the credentials or input it received. Values shorter than 4
 * characters are not matched (too many false positives).
 */
export function redactSecretValues(value: unknown, secrets: readonly string[]): unknown {
  const list = [...new Set(secrets.filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  if (list.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const s of list) if (out.includes(s)) out = out.split(s).join(REDACTED);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value);
}
