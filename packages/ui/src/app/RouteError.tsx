import { isRouteErrorResponse, useRouteError } from 'react-router';

import { Banner } from '../components/Banner.js';
import { LinkButton } from '../components/LinkButton.js';

/** The router's error element: a readable message instead of a blank page. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  return (
    <div
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <Banner tone="error" title="This screen failed to render">
        {message}
      </Banner>
      <LinkButton to="/" variant="outline" size="sm" icon="board">
        Back to the Board
      </LinkButton>
    </div>
  );
}
