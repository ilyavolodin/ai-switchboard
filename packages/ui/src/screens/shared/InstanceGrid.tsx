import type { ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Skeleton } from '../../components/Skeleton.js';
import styles from '../Sources/instanceCard.module.css';

/** The query fields the grid reads (a TanStack Query result fits). */
interface ListQuery<T> {
  data: T[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

/**
 * The Sources and Executors card grids: skeletons while loading, an error with Retry, the
 * teaching empty state, and an amber banner naming the instances whose plugin did not load.
 */
export function InstanceGrid<T extends { id: string; name: string; pluginAvailable: boolean }>({
  query,
  title,
  empty,
  heldNote,
  renderCard,
  footer,
}: {
  query: ListQuery<T>;
  /** "Sources", "Executors". */
  title: string;
  empty: ReactNode;
  /** Finishes "<names> stay configured, but their plugin did not load at start; …". */
  heldNote: string;
  renderCard: (item: T) => ReactNode;
  footer?: ReactNode;
}) {
  if (query.isPending) {
    return (
      <div className={styles.grid}>
        <Skeleton shape="card" height={220} label={`Loading ${title.toLowerCase()}`} />
        <Skeleton shape="card" height={220} />
        <Skeleton shape="card" height={220} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Banner
        tone="error"
        title={`${title} could not load`}
        actions={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Banner>
    );
  }
  const list = query.data ?? [];
  if (list.length === 0) return <>{empty}</>;
  const unavailable = list.filter((x) => !x.pluginAvailable);
  return (
    <>
      {unavailable.length > 0 && (
        <Banner tone="warn" title="A plugin is unavailable">
          {unavailable.map((x) => x.name).join(', ')} stay configured, but their plugin did not load
          at start; {heldNote}
        </Banner>
      )}
      <div className={styles.grid}>{list.map((x) => renderCard(x))}</div>
      {footer}
    </>
  );
}
