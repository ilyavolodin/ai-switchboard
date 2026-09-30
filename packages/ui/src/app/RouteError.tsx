import { isRouteErrorResponse, useRouteError } from 'react-router';

import { Banner } from '../components/Banner.js';
import { LinkButton } from '../components/LinkButton.js';
import styles from './RouteError.module.css';

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  return (
    <div className={styles.page}>
      <Banner tone="error" title="This screen failed to render">
        {message}
      </Banner>
      <LinkButton to="/" variant="outline" size="sm" icon="board">
        Back to the Board
      </LinkButton>
    </div>
  );
}
