import { Fragment } from 'react';
import { Link } from 'react-router';

import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';

export interface InUseBannerProps {
  name: string;
  kind: 'source' | 'destination' | 'notifier';
  processes: { id: string; name: string }[];
  onDismiss: () => void;
}

const WHAT_TO_DO: Record<InUseBannerProps['kind'], string> = {
  source: 'remove its triggers from each',
  destination: 'bind each to another destination and remove the steps that use it',
  notifier: 'remove its notifications and steps from each',
};

/**
 * Removing the references is left to a person on purpose: each edit changes what that process does
 * (and a process cannot lose its destination).
 */
export function InUseBanner({ name, kind, processes, onDismiss }: InUseBannerProps) {
  const many = processes.length > 1;
  return (
    <Banner
      tone="warn"
      title={`${name} is still in use`}
      actions={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      Used by{' '}
      {processes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && ', '}
          <Link to={`/processes/${encodeURIComponent(p.id)}/edit`}>{p.name}</Link>
        </Fragment>
      ))}
      {`. To delete this ${kind}, ${WHAT_TO_DO[kind]} (or delete ${many ? 'those processes' : 'the process'}), then try again.`}
    </Banner>
  );
}
