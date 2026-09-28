/**
 * Deprecated aliases from before "executor" was renamed "destination" (SDK 2.0.0). Fastify's
 * `rewriteUrl` hook runs before routing, so an old URL is served by the current route:
 *
 * - `/api/v1/executors…` → `/api/v1/destinations…`
 * - `kind=executor` (on `GET /plugin-types` and `GET /plugins/search`) → `kind=destination`
 * - the `executor=` filter (on `GET /runs`, `GET /events`, ...) → `destination=`
 *
 * Responses use the current DTOs (`destinationId`, `destinations`, ...). Remove these aliases in
 * a future major.
 */
export function rewriteLegacyUrl(url: string): string {
  if (!url.startsWith('/api/v1/')) return url;
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  let query = q === -1 ? '' : url.slice(q + 1);

  if (path === '/api/v1/executors' || path.startsWith('/api/v1/executors/')) {
    path = `/api/v1/destinations${path.slice('/api/v1/executors'.length)}`;
  }
  if (query !== '' && /(^|&)(kind=executor|executor=)/.test(query)) {
    const params = query.split('&');
    const hasDestination = params.some((p) => p.startsWith('destination='));
    query = params
      .map((p) => {
        if (p === 'kind=executor') return 'kind=destination';
        if (p.startsWith('executor=') && !hasDestination) return `destination=${p.slice(9)}`;
        return p;
      })
      .join('&');
  }
  return query === '' && q === -1 ? path : `${path}?${query}`;
}
