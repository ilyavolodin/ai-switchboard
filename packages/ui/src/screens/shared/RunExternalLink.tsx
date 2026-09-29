import type { RunSummary } from '@ai-switchboard/core/contract';

import styles from './RunsTable.module.css';

export function RunExternalLink({ run }: { run: RunSummary }) {
  if (!run.externalUrl) return <span className="mono">{run.externalId ?? '—'}</span>;
  return (
    <a
      href={run.externalUrl}
      target="_blank"
      rel="noreferrer"
      className={styles.external}
      aria-label={`Open run ${run.id} in ${run.destinationName} (new tab)`}
    >
      {run.externalId ?? 'open'} ↗
    </a>
  );
}
