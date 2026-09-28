import { Link } from 'react-router';

import type { WhyItem } from '../lib/why.js';
import { StatusChip } from './StatusChip.js';
import { Tooltip } from './Tooltip.js';
import styles from './WhyNothingRan.module.css';

const NOW_TIP =
  'Explained from the configuration as it is now: nothing was recorded for this process when the event arrived.';

/**
 * The list of processes that did not take an event, each with its reason (process disabled,
 * trigger disabled, event type not subscribed, filter false or error, type muted, source
 * disabled, event invalid). `label` names the list for assistive tech.
 */
export function WhyNothingRan({ items, label }: { items: readonly WhyItem[]; label: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((x) => (
        <li key={`${x.processId ?? ''}:${x.reason}`} className={styles.item}>
          <StatusChip size="sm" tone={x.tone} label="not taken" />
          <span className={styles.text}>
            {x.processId ? (
              <Link to={`/processes/${encodeURIComponent(x.processId)}`}>
                {x.processName ?? x.processId}
              </Link>
            ) : null}
            {x.processId ? ': ' : ''}
            {x.reason}
            {x.basis === 'now' && (
              <Tooltip content={NOW_TIP}>
                <span className={styles.now} tabIndex={0}>
                  {' '}
                  (now)
                </span>
              </Tooltip>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
