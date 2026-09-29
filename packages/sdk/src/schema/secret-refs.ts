export const SECRET_SCHEME = 'secret://';

/** A reference as settings store it: `secret://<provider>/<name>`. */
export interface SecretRef {
  /** The name (or type id) of the secret provider instance. */
  provider: string;
  /** May contain `/`. */
  name: string;
}

/** What a `<provider>` segment may contain for a reference the UI builds. */
export const SECRET_PROVIDER_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function isSecretProviderSegment(value: string): boolean {
  return SECRET_PROVIDER_SEGMENT.test(value);
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_SCHEME);
}

/** Null unless `value` is `secret://` followed by a non-empty provider, `/` and a non-empty name. */
export function parseSecretRef(value: unknown): SecretRef | null {
  if (!isSecretRef(value)) return null;
  const rest = value.slice(SECRET_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

export function formatSecretRef(ref: SecretRef): string {
  return `${SECRET_SCHEME}${ref.provider}/${ref.name}`;
}
