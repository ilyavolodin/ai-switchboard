import { SECRET_SCHEME, formatSecretRef, parseSecretRef } from '@ai-switchboard/sdk';

import { KEEP, mapJson, walkJson } from '../util/json.js';

export const SECRET_MARKER_KEY = '$secretRef';

/** What `$secretRef(name)` returns: a reference the destination bridge resolves after evaluation. */
export interface SecretRefMarker {
  [SECRET_MARKER_KEY]: string;
}

/** `provider/name` or `secret://provider/name` as a `secret://` reference; throws on anything else. */
export function secretRefString(name: string): string {
  const trimmed = name.trim();
  const parsed = parseSecretRef(
    trimmed.startsWith(SECRET_SCHEME) ? trimmed : `${SECRET_SCHEME}${trimmed}`,
  );
  if (!parsed) {
    throw new Error(
      `$secretRef expects "<provider>/<name>" or "secret://<provider>/<name>", got "${name}"`,
    );
  }
  return formatSecretRef(parsed);
}

export function isSecretRefMarker(value: unknown): value is SecretRefMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === SECRET_MARKER_KEY &&
    typeof (value as Record<string, unknown>)[SECRET_MARKER_KEY] === 'string'
  );
}

export function collectSecretMarkers(value: unknown): Set<string> {
  const out = new Set<string>();
  walkJson(value, (node) => {
    if (!isSecretRefMarker(node)) return false;
    out.add(node[SECRET_MARKER_KEY]);
    return true;
  });
  return out;
}

export function replaceSecretMarkers(value: unknown, replace: (ref: string) => unknown): unknown {
  return mapJson(value, (node) =>
    isSecretRefMarker(node) ? replace(node[SECRET_MARKER_KEY]) : KEEP,
  );
}

/** Called immediately before a plugin call; the resolved value is never stored. */
export async function resolveSecretMarkers(
  value: unknown,
  resolve: (ref: string) => Promise<string>,
): Promise<{ value: unknown; secrets: string[] }> {
  const refs = [...collectSecretMarkers(value)];
  const resolved = await Promise.all(refs.map(async (ref) => [ref, await resolve(ref)] as const));
  const values = new Map(resolved);
  return {
    value: replaceSecretMarkers(value, (ref) => values.get(ref)),
    secrets: [...values.values()],
  };
}

/**
 * Only `$secretRef` inside the expression may make a marker; one in the data it reads is forged
 * and becomes null, so the bridge never resolves a secret a payload asked for.
 */
export function neutralizeSecretMarkers(value: unknown): unknown {
  return collectSecretMarkers(value).size === 0 ? value : replaceSecretMarkers(value, () => null);
}
