import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';

export function UnknownTab({ overview }: { overview: string }) {
  return (
    <EmptyState
      title="No such tab"
      compact
      actions={
        <LinkButton to={overview} variant="outline">
          Overview
        </LinkButton>
      }
    />
  );
}
