import type { ActivityRow, StatusTone } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useEvents, useExecutors, useProcesses, useSources } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadMore } from '../../components/LoadMore.js';
import { SearchInput } from '../../components/SearchInput.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { traceHref } from '../../lib/artifact.js';
import { now } from '../../lib/clock.js';
import { toneVars } from '../../lib/tone.js';
import styles from './Activity.module.css';
import {
  DEFAULT_RANGE,
  type FilterKey,
  hasFilters,
  RANGES,
  readFilters,
  STAGE_OPTIONS,
  toActivityQuery,
  toneCounts,
  withFilter,
} from './filters.js';

const LEGEND: { tone: StatusTone; label: string }[] = [
  { tone: 'ok', label: 'flowing / run ok' },
  { tone: 'warn', label: 'held / throttled' },
  { tone: 'error', label: 'error' },
  { tone: 'off', label: 'stopped early' },
];

/**
 * Activity: the fleet-wide event stream. Every event with where it stopped (five stops) and the
 * processes it reached, filtered from the URL; the search box traces one artifact. Polls 15 s.
 */
export function Activity() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const filters = readFilters(params);
  // The moment the time range was chosen: the query's lower bound stays put while live refresh
  // brings in newer events.
  const [anchor, setAnchor] = useState(now);
  const events = useEvents(toActivityQuery(filters, anchor));
  const sources = useSources();
  const processes = useProcesses();
  const executors = useExecutors();

  const setFilter = (key: FilterKey, value: string) => {
    if (key === 'range') setAnchor(now());
    setParams(withFilter(params, key, value), { replace: true });
  };

  const onTrace = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('trace');
    if (typeof q === 'string' && q.trim()) void navigate(traceHref(q.trim()));
  };

  const onArtifact = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('artifact');
    setFilter('artifact', typeof q === 'string' ? q.trim() : '');
  };

  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = toneCounts(rows);

  return (
    <>
      <div className={styles.header}>
        <h1 className="t-screen-title">Activity</h1>
        <span className="t-caption">every event and where it stopped</span>
        <span className={styles.spacer} />
        <form role="search" className={styles.traceForm} onSubmit={onTrace}>
          <SearchInput
            name="trace"
            mono
            label="Trace an artifact"
            placeholder="artifact id — what happened to LOL-1712?"
            className={styles.traceInput}
          />
        </form>
      </div>

      <div className={styles.filters} role="group" aria-label="Filters">
        <Select
          size="sm"
          aria-label="Source"
          value={filters.source ?? ''}
          placeholder="All sources"
          options={(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          onChange={(e) => {
            setFilter('source', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Process"
          value={filters.process ?? ''}
          placeholder="All processes"
          options={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          onChange={(e) => {
            setFilter('process', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Executor"
          value={filters.executor ?? ''}
          placeholder="All executors"
          options={(executors.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
          onChange={(e) => {
            setFilter('executor', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Stage"
          value={filters.stage ?? ''}
          placeholder="Any stage"
          options={STAGE_OPTIONS}
          onChange={(e) => {
            setFilter('stage', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Time range"
          value={filters.range ?? DEFAULT_RANGE}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          onChange={(e) => {
            setFilter('range', e.target.value === DEFAULT_RANGE ? '' : e.target.value);
          }}
        />
        <form className={styles.artifactForm} onSubmit={onArtifact}>
          <TextField
            key={filters.artifact ?? ''}
            name="artifact"
            size="sm"
            mono
            aria-label="Artifact id"
            placeholder="artifact id"
            defaultValue={filters.artifact ?? ''}
            onBlur={(e) => {
              if (e.target.value.trim() !== (filters.artifact ?? '')) {
                setFilter('artifact', e.target.value.trim());
              }
            }}
          />
        </form>
        {hasFilters(filters) && (
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            onClick={() => {
              setParams(filters.range ? { range: filters.range } : {}, { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
        <span className={styles.spacer} />
        {rows.length > 0 && (
          <ul className={styles.legend} aria-label="Where events stopped (loaded rows)">
            {LEGEND.map((l) => (
              <li key={l.tone} className={styles.legendKey}>
                <span
                  className={styles.swatch}
                  style={{
                    background: l.tone === 'off' ? 'var(--border-4)' : toneVars(l.tone).fill,
                  }}
                  aria-hidden="true"
                />
                {l.label} · <span className="mono">{counts[l.tone]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {events.isPending ? (
        <Card padding="flush">
          <Skeleton lines={8} height={28} label="Loading activity" />
        </Card>
      ) : events.isError ? (
        <Banner
          tone="error"
          title="Activity could not load"
          actions={
            <Button size="sm" variant="outline" onClick={() => void events.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(events.error)}
        </Banner>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={hasFilters(filters) ? 'No events match these filters' : 'No events yet'}
          >
            {hasFilters(filters)
              ? 'Widen the time range or clear a filter. Events older than the retention window are gone.'
              : 'Events appear here as soon as a source receives one. Send a test event from a source to see the pipeline work.'}
          </EmptyState>
        </Card>
      ) : (
        <Card padding="flush" className={styles.stream}>
          <div className={styles.head} aria-hidden="true">
            <span>time</span>
            <span>event</span>
            <span>artifact</span>
            <span>received › matched › batched › gated › invoked</span>
            <span>processes</span>
          </div>
          <ul className={styles.rows} aria-label="Events">
            {rows.map((r) => (
              <EventRow key={r.eventId} row={r} />
            ))}
          </ul>
          <LoadMore
            hasMore={events.hasNextPage}
            loading={events.isFetchingNextPage}
            onLoadMore={() => void events.fetchNextPage()}
          />
        </Card>
      )}
    </>
  );
}

function EventRow({ row }: { row: ActivityRow }) {
  return (
    <li
      className={styles.row}
      aria-label={`${row.type} ${row.artifact.id}: ${row.indicator.label}`}
    >
      <span className={styles.time}>
        <Time value={row.receivedAt} format="clock" />
      </span>
      <span className={styles.event}>
        <span className={styles.type}>{row.type}</span>
        <span className={styles.source}>
          {row.sourceName}
          {row.replayOf && ' · replay'}
        </span>
      </span>
      <span className={styles.artifact}>
        <ArtifactChip artifact={row.artifact} to={traceHref(row.artifact.id)} />
      </span>
      <span className={styles.stage}>
        <StageIndicator indicator={row.indicator} />
      </span>
      <span className={styles.processes}>
        {row.processes.length === 0 ? (
          <span className={styles.none}>no process</span>
        ) : (
          row.processes.map((p) => (
            <span key={p.id} className={styles.process}>
              <Link to={`/processes/${encodeURIComponent(p.id)}`}>{p.name}</Link>
              <span className={styles.outcome}>
                {' '}
                {(p.runStatus ?? p.outcome).replace(/_/g, ' ')}
              </span>
            </span>
          ))
        )}
      </span>
    </li>
  );
}
