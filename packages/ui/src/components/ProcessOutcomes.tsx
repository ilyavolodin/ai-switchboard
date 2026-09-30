import { Link } from 'react-router';

import { processHref } from '../lib/hrefs.js';
import { type ProcessOutcome, processOutcomeLabel } from '../lib/processOutcome.js';
import styles from './ProcessOutcomes.module.css';
import { StatusChip } from './StatusChip.js';

/** What happened to one event in each process that matched it: a linked name and a chip. */
export function ProcessOutcomes({ processes }: { processes: readonly ProcessOutcome[] }) {
  return (
    <>
      {processes.map((p) => (
        <span key={p.id} className={styles.outcome}>
          <Link to={processHref(p.id)}>{p.name}</Link>
          <StatusChip size="sm" {...processOutcomeLabel(p)} />
        </span>
      ))}
    </>
  );
}
