import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';

export function UnknownTab({
  to,
  label = 'Overview',
  title = 'No such tab',
}: {
  to: string;
  label?: string;
  title?: string;
}) {
  return (
    <EmptyState
      title={title}
      compact
      actions={
        <LinkButton to={to} variant="outline">
          {label}
        </LinkButton>
      }
    />
  );
}
