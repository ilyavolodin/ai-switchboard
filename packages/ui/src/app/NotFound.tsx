import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { LinkButton } from '../components/LinkButton.js';

/** Unknown paths inside the shell. */
export function NotFound() {
  return (
    <Card>
      <EmptyState
        title="Nothing lives at this address"
        actions={
          <LinkButton to="/" variant="outline" size="sm" icon="board">
            Back to the Board
          </LinkButton>
        }
      >
        The link may be old, or the thing it pointed at was removed.
      </EmptyState>
    </Card>
  );
}
