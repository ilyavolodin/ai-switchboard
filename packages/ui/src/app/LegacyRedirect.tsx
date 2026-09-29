import { Navigate, useLocation } from 'react-router';

/** Deprecated: keeps old `/executors…` bookmarks working. Remove in a future major. */
export function LegacyExecutorsRedirect() {
  const { pathname, search, hash } = useLocation();
  const to = pathname.replace(/^\/executors(?=\/|$)/, '/destinations');
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
