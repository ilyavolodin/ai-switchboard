export const SECRET_MARKER_KEY = '$secretRef';

/** What `$secretRef(name)` returns: a reference the destination bridge resolves after evaluation. */
export interface SecretRefMarker {
  $secretRef: string;
}

export function secretRefString(name: string): string {
  const trimmed = name.trim();
  const bare = trimmed.startsWith('secret://') ? trimmed.slice('secret://'.length) : trimmed;
  const slash = bare.indexOf('/');
  if (slash <= 0 || slash === bare.length - 1) {
    throw new Error(
      `$secretRef expects "<provider>/<name>" or "secret://<provider>/<name>", got "${name}"`,
    );
  }
  return `secret://${bare}`;
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

export function collectSecretMarkers(value: unknown, out = new Set<string>()): Set<string> {
  if (isSecretRefMarker(value)) {
    out.add(value.$secretRef);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretMarkers(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectSecretMarkers(item, out);
  }
  return out;
}

export function replaceSecretMarkers(value: unknown, replace: (ref: string) => unknown): unknown {
  if (isSecretRefMarker(value)) return replace(value.$secretRef);
  if (Array.isArray(value)) return value.map((item) => replaceSecretMarkers(item, replace));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceSecretMarkers(v, replace);
    return out;
  }
  return value;
}

/** Called immediately before a plugin call; the resolved value is never stored. */
export async function resolveSecretMarkers(
  value: unknown,
  resolve: (ref: string) => Promise<string>,
): Promise<{ value: unknown; secrets: string[] }> {
  const values = new Map<string, string>();
  for (const ref of collectSecretMarkers(value)) values.set(ref, await resolve(ref));
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
