import type { ReactNode } from 'react';

import { Banner } from '../../components/Banner.js';
import { type BoundaryQuery, QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from './instanceCard.module.css';

export function InstanceGrid<T extends { id: string; name: string; pluginAvailable: boolean }>({
  query,
  title,
  empty,
  heldNote,
  renderCard,
  footer,
}: {
  query: BoundaryQuery<T[]>;
  title: string;
  empty: ReactNode;
  /** Finishes "<names> stay configured, but their plugin did not load at start; …". */
  heldNote: string;
  renderCard: (item: T) => ReactNode;
  footer?: ReactNode;
}) {
  return (
    <QueryBoundary
      query={query}
      errorTitle={`${title} could not load`}
      empty={empty}
      pending={
        <div className={styles.grid}>
          <Skeleton shape="card" height={220} label={`Loading ${title.toLowerCase()}`} />
          <Skeleton shape="card" height={220} />
          <Skeleton shape="card" height={220} />
        </div>
      }
    >
      {(list) => {
        const unavailable = list.filter((x) => !x.pluginAvailable);
        return (
          <>
            {unavailable.length > 0 && (
              <Banner tone="warn" title="A plugin is unavailable">
                {unavailable.map((x) => x.name).join(', ')} stay configured, but their plugin did
                not load at start; {heldNote}
              </Banner>
            )}
            <div className={styles.grid}>{list.map((x) => renderCard(x))}</div>
            {footer}
          </>
        );
      }}
    </QueryBoundary>
  );
}
