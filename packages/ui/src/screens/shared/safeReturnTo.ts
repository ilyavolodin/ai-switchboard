/**
 * Where to go after signing in or changing a password: the `from` in router state when it is a
 * path inside the app (`//host` is another site) and not the page itself, else `/`.
 */
export function safeReturnTo(state: unknown, own: string): string {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/';
  const path = from.split(/[?#]/, 1)[0];
  return path === own ? '/' : from;
}
