import { isApiRequestError, errorMessage } from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';

export function LoadFailure({
  error,
  noun,
  listTo,
  listLabel,
}: {
  error: unknown;
  noun: string;
  listTo: string;
  listLabel: string;
}) {
  const missing = isApiRequestError(error) && error.status === 404;
  return (
    <EmptyState
      title={missing ? `This ${noun} does not exist` : `The ${noun} could not load`}
      actions={
        <LinkButton to={listTo} variant="outline">
          {listLabel}
        </LinkButton>
      }
    >
      {missing ? 'It may have been deleted.' : errorMessage(error)}
    </EmptyState>
  );
}
