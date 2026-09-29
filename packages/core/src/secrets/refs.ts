import { SECRET_SCHEME, isSecretRef, parseSecretRef } from '@ai-switchboard/sdk';

export {
  SECRET_SCHEME,
  formatSecretRef,
  isSecretRef,
  parseSecretRef,
  type SecretRef,
} from '@ai-switchboard/sdk';

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

/** `$secretRef('<provider>/<name>')` (or with a full `secret://` reference) in expression text. */
const EXPRESSION_REF = /\$secretRef\(\s*(['"])(?:secret:\/\/)?([^'"\s]+)\1\s*\)/g;

/** Also finds literal `$secretRef('<provider>/<name>')` calls inside expression strings. */
export function collectDocumentSecretRefs(value: unknown): { path: string; ref: string }[] {
  const out = collectSecretRefs(value);
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(EXPRESSION_REF)) {
        const ref = `${SECRET_SCHEME}${m[2] ?? ''}`;
        if (parseSecretRef(ref)) out.push({ path, ref });
      }
    } else if (Array.isArray(v)) {
      v.forEach((inner, i) => {
        walk(inner, `${path}[${i}]`);
      });
    } else if (v !== null && typeof v === 'object') {
      for (const [k, inner] of Object.entries(v)) walk(inner, path === '' ? k : `${path}.${k}`);
    }
  };
  walk(value, '');
  return out;
}

export function referencesProvider(value: unknown, providers: ReadonlySet<string>): boolean {
  return collectSecretRefs(value).some((r) => {
    const parsed = parseSecretRef(r.ref);
    return parsed !== null && providers.has(parsed.provider);
  });
}

export type SecretLookup = (ref: string) => Promise<string>;

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

/** Fields marked `x-secret` must hold a reference (or be empty), never a literal value. */
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
 * Applied to what a backend sends back before it is stored, since a backend may echo the
 * credentials it received. Values shorter than 4 characters are not matched (false positives).
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
