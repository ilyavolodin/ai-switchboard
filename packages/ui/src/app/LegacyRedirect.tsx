import { Navigate, useLocation } from 'react-router';

/**
 * Old `/executors…` links (before "executor" became "destination") land on the same page under
 * `/destinations…`, keeping the rest of the path, the query and the hash.
 * A deprecated alias kept so bookmarks and shared links keep working; remove in a future major.
 */
export function LegacyExecutorsRedirect() {
  const { pathname, search, hash } = useLocation();
  const to = pathname.replace(/^\/executors(?=\/|$)/, '/destinations');
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
