/**
 * Deprecated "executor" URL aliases (renamed "destination" in SDK 2.0.0), rewritten before routing
 * so the current route serves them. Responses use the current DTOs. Remove in a future major.
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
