import type { ActivityRow, SourceDetail } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useEvent, useReplayEvent, useSourceEvents } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Icon } from '../../components/Icon.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { LoadMore } from '../../components/LoadMore.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { traceHref } from '../../lib/artifact.js';
import { cx } from '../../lib/cx.js';
import { runStatusTone } from '../../lib/tone.js';
import styles from './detail.module.css';

/**
 * The source's Events tab: its recent events, newest first, each with the processes it matched;
 * expanding a row shows its attributes (collapsible key/value list) and delivery facts, and
 * offers Replay. Pages with Load more.
 */
export function SourceEventsTab({ source }: { source: SourceDetail }) {
  const [type, setType] = useState('');
  const events = useSourceEvents(source.id, type || undefined);
  const [open, setOpen] = useState<string | null>(null);
  const types = [
    ...new Set([
      ...source.eventTypes.map((t) => t.type),
      ...source.eventsByType24h.map((t) => t.type),
    ]),
  ];
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card padding="normal">
      <div className={styles.toolbar}>
        <Select
          size="sm"
          className={styles.toolbarSelect}
          aria-label="Event type"
          options={[
            { value: '', label: 'All types' },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
          value={type}
          onChange={(e) => {
            setType(e.target.value);
          }}
        />
        <span className={styles.grow} />
        <span className={styles.caption}>
          Newest first · events are kept per the retention setting.
        </span>
      </div>
      {events.isPending ? (
        <Skeleton lines={6} height={28} label="Loading events" />
      ) : events.isError ? (
        <Banner tone="error" title="Events could not load">
          {errorMessage(events.error)}
        </Banner>
      ) : rows.length === 0 ? (
        <EmptyState title="No events yet" compact>
          {type
            ? `No ${type} events from this source.`
            : 'Events appear here as deliveries arrive. Send a test event to see one.'}
        </EmptyState>
      ) : (
        <ul className={styles.events} aria-label={`Events from ${source.name}`}>
          {rows.map((row) => (
            <EventItem
              key={row.eventId}
              row={row}
              open={open === row.eventId}
              onToggle={() => {
                setOpen((o) => (o === row.eventId ? null : row.eventId));
              }}
            />
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={events.hasNextPage}
        loading={events.isFetchingNextPage}
        onLoadMore={() => void events.fetchNextPage()}
        label="Load more events"
      />
    </Card>
  );
}

function EventItem({
  row,
  open,
  onToggle,
}: {
  row: ActivityRow;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = `event-${row.eventId}`;
  return (
    <li className={styles.event}>
      <div className={styles.eventRow}>
        <button
          type="button"
          className={styles.expand}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Hide' : 'Show'} ${row.type} ${row.artifact.id}`}
          onClick={onToggle}
        >
          <Icon name="back" size={12} className={cx(styles.chev, open && styles.chevOpen)} />
        </button>
        <Time value={row.receivedAt} format="clock-seconds" className="mono" />
        <span className="mono">
          {row.type}
          {row.replayOf && <span className="t-caption"> · replay</span>}
        </span>
        <ArtifactChip artifact={row.artifact} to={traceHref(row.artifact.id)} />
        <span className={styles.matches}>
          {row.processes.length === 0 ? (
            <StageIndicator indicator={row.indicator} compact />
          ) : (
            row.processes.map((p) => (
              <StatusChip
                key={p.id}
                size="sm"
                tone={p.runStatus ? runStatusTone(p.runStatus) : 'off'}
                label={`${p.name} · ${p.runStatus ? `run ${p.runStatus}` : p.outcome}`}
              />
            ))
          )}
        </span>
      </div>
      {open && <EventPanel id={panelId} row={row} />}
    </li>
  );
}

function EventPanel({ id, row }: { id: string; row: ActivityRow }) {
  const detail = useEvent(row.eventId);
  const names = row.processes.map((p) => p.name);
  const replay = useReasonedMutation(
    useReplayEvent(),
    {
      title: 'Replay this event?',
      consequence:
        names.length > 0
          ? `It is dispatched again as a new event and reaches ${names.join(' and ')} if their triggers still match.`
          : 'It is dispatched again as a new event; processes whose triggers match it now will receive it.',
      confirmLabel: 'Replay',
    },
    { successMessage: (d) => `Replayed as ${d.eventIds.join(', ')}` },
  );

  return (
    <div id={id} className={styles.eventDetail}>
      <div>
        <p className={styles.detailTitle}>Attributes</p>
        {detail.isPending ? (
          <Skeleton lines={4} label="Loading the event" />
        ) : detail.isError ? (
          <span className={styles.caption}>{errorMessage(detail.error)}</span>
        ) : (
          <KeyValueList data={detail.data.attributes} initialRows={6} label="Event attributes" />
        )}
      </div>
      <div>
        <p className={styles.detailTitle}>Delivery</p>
        {detail.data && (
          <KeyValueList
            label="Delivery facts"
            data={[
              ['event id', <span className="mono">{detail.data.eventId}</span>],
              ['delivery', <span className="mono">{detail.data.deliveryId ?? '—'}</span>],
              ['received', <Time value={detail.data.receivedAt} format="clock-seconds" />],
              ['stage', detail.data.indicator.label],
              ...(detail.data.stageReason
                ? ([['why', detail.data.stageReason]] as [string, string][])
                : []),
            ]}
          />
        )}
        <p className={styles.detailTitle} style={{ marginTop: 12 }}>
          Processes matched
        </p>
        {row.processes.length === 0 ? (
          <span className={styles.caption}>No process matched.</span>
        ) : (
          <ul className={styles.list}>
            {row.processes.map((p) => (
              <li key={p.id} className={styles.listRow}>
                <Link to={`/processes/${p.id}`} className={styles.grow}>
                  {p.name}
                </Link>
                <span className="t-caption">{p.outcome}</span>
                {p.runStatus && (
                  <StatusChip
                    size="sm"
                    tone={runStatusTone(p.runStatus)}
                    label={`run ${p.runStatus}`}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.replay}>
          <Button
            size="sm"
            variant="outline"
            icon="refresh"
            requires="operator"
            loading={replay.pending}
            onClick={() => void replay.run({ id: row.eventId })}
          >
            Replay
          </Button>
          <Link to={traceHref(row.artifact.id)} className="t-caption">
            Open the trace
          </Link>
        </div>
      </div>
    </div>
  );
}
