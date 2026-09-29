import { errorMessage } from '../api/client.js';
import { Banner } from './Banner.js';
import { Button } from './Button.js';

export interface RetryableQuery {
  error: unknown;
  refetch: () => Promise<unknown>;
}

/** `title` names what failed, e.g. "Runs could not load". */
export function QueryError({ query, title }: { query: RetryableQuery; title: string }) {
  return (
    <Banner
      tone="error"
      title={title}
      actions={
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      }
    >
      {errorMessage(query.error)}
    </Banner>
  );
}
