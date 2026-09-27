import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useProcessActivity } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { artifactLabel, traceHref } from '../../lib/artifact.js';
import { runStatusTone } from '../../lib/tone.js';
import styles from './ProcessDetail.module.css';

/**
 * The process's trace list: every event that reached it, newest first, with a stage indicator
 * showing how far it got and a link to the artifact's full trace.
 */
export function ActivityTab({ processId }: { processId: string }) {
  const activity = useProcessActivity(processId);
  const rows = activity.data?.pages.flatMap((p) => p.items) ?? [];

  if (activity.isPending) return <Skeleton lines={6} height={36} label="Loading activity" />;
  if (activity.isError) {
    return (
      <Banner tone="error" title="Could not load activity">
        {errorMessage(activity.error)}
      </Banner>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title="No events yet" compact>
          Events that match a trigger show up here with how far they got. Send a test event from the
          source to see one.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card padding="flush">
      <ol className={styles.traceList} aria-label="Process activity">
        {rows.map((r) => {
          const mine = r.processes.find((p) => p.id === processId);
          return (
            <li key={r.eventId} className={styles.traceRow}>
              <Time value={r.receivedAt} format="clock-seconds" className={styles.traceTime} />
              <span className={styles.traceSource}>
                {r.sourceName}
                <span className="mono t-caption"> {r.type}</span>
              </span>
              <ArtifactChip artifact={r.artifact} to={traceHref(r.artifact.id)} />
              <StageIndicator indicator={r.indicator} />
              <span className={styles.traceOutcome}>
                {mine?.runStatus ? (
                  <StatusChip
                    tone={runStatusTone(mine.runStatus)}
                    label={`run ${mine.runStatus}`}
                    size="sm"
                  />
                ) : mine ? (
                  <span className="t-caption">{mine.outcome}</span>
                ) : null}
              </span>
              <Link
                to={traceHref(r.artifact.id)}
                className={styles.traceLink}
                aria-label={`Trace ${artifactLabel(r.artifact)}`}
              >
                trace ›
              </Link>
            </li>
          );
        })}
      </ol>
      <LoadMore
        hasMore={activity.hasNextPage}
        loading={activity.isFetchingNextPage}
        onLoadMore={() => {
          void activity.fetchNextPage();
        }}
        label="Load more events"
      />
    </Card>
  );
}
