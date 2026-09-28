import { Fragment } from 'react';
import { Link } from 'react-router';

import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';

export interface InUseBannerProps {
  /** "Linear — acme" */
  name: string;
  kind: 'source' | 'executor' | 'notifier';
  /** The processes the API's 409 named (`ApiError.usedBy`). */
  processes: { id: string; name: string }[];
  onDismiss: () => void;
}

const WHAT_TO_DO: Record<InUseBannerProps['kind'], string> = {
  source: 'remove its triggers from each',
  executor: 'bind each to another executor and remove the steps that use it',
  notifier: 'remove its notifications and steps from each',
};

/**
 * Why a delete was refused: the processes that still use the instance, each a link to its
 * editor, and what to change there. Removing the references is left to a person on purpose —
 * each edit changes what that process does (and a process cannot lose its executor).
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
