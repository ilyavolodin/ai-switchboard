import { SECRET_SCHEME, isSecretRef, parseSecretRef } from '@ai-switchboard/sdk';

import { KEEP, mapJson, mapJsonAsync, walkJson, type JsonPath } from '../util/json.js';

export {
  SECRET_SCHEME,
  formatSecretRef,
  isSecretRef,
  parseSecretRef,
  type SecretRef,
} from '@ai-switchboard/sdk';

/**
 * Secret values shorter than this are never matched in text (redaction, the event and state
 * guards): they would match ordinary words by accident. One threshold for every check, set low,
 * so a short credential is still caught; the cost is a rare false positive, never a leak.
 */
export const MIN_SECRET_MATCH_LENGTH = 4;

export function matchableSecrets(values: Iterable<string>): string[] {
  return [...values].filter((s) => s.length >= MIN_SECRET_MATCH_LENGTH);
}

export interface FoundSecretRef {
  path: JsonPath;
  ref: string;
}

export function collectSecretRefs(value: unknown): FoundSecretRef[] {
  const out: FoundSecretRef[] = [];
  walkJson(value, (node, path) => {
    if (isSecretRef(node)) out.push({ path, ref: node });
  });
  return out;
}

/** `$secretRef('<provider>/<name>')` (or with a full `secret://` reference) in expression text. */
const EXPRESSION_REF = /\$secretRef\(\s*(['"])(?:secret:\/\/)?([^'"\s]+)\1\s*\)/g;

/** `secret://` fields, and literal `$secretRef('<provider>/<name>')` calls inside expressions. */
export function collectDocumentSecretRefs(value: unknown): FoundSecretRef[] {
  const out: FoundSecretRef[] = [];
  walkJson(value, (node, path) => {
    if (isSecretRef(node)) {
      out.push({ path, ref: node });
      return;
    }
    if (typeof node !== 'string') return;
    for (const m of node.matchAll(EXPRESSION_REF)) {
      const ref = `${SECRET_SCHEME}${m[2] ?? ''}`;
      if (parseSecretRef(ref)) out.push({ path, ref });
    }
  });
  return out;
}

export function referencesProvider(value: unknown, providers: ReadonlySet<string>): boolean {
  return collectSecretRefs(value).some((r) => {
    const parsed = parseSecretRef(r.ref);
    return parsed !== null && providers.has(parsed.provider);
  });
}

export type SecretLookup = (ref: string) => Promise<string>;

/** References are looked up in parallel; `secrets` lists the resolved values. */
export async function resolveSecretRefs(
  value: unknown,
  lookup: SecretLookup,
): Promise<{ value: unknown; secrets: string[] }> {
  const secrets: string[] = [];
  const resolved = await mapJsonAsync(value, async (node) => {
    if (!isSecretRef(node)) return KEEP;
    const secret = await lookup(node);
    secrets.push(secret);
    return secret;
  });
  return { value: resolved, secrets };
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
 * credentials it received.
 */
export function redactSecretValues(value: unknown, secrets: readonly string[]): unknown {
  const list = [...new Set(matchableSecrets(secrets))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return value;
  return mapJson(value, (node) => {
    if (typeof node !== 'string') return KEEP;
    let out = node;
    for (const s of list) if (out.includes(s)) out = out.split(s).join(REDACTED);
    return out;
  });
}
