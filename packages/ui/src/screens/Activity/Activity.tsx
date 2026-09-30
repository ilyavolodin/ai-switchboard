import type { ActivityRow, StatusTone } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useDestinations, useEvents, useProcesses, useSources } from '../../api/index.js';
import { ArtifactChip } from '../../components/ArtifactChip.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LoadMore } from '../../components/LoadMore.js';
import { PageHeader } from '../../components/PageHeader.js';
import { ProcessOutcomes } from '../../components/ProcessOutcomes.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StageIndicator } from '../../components/StageIndicator.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { TraceSearchForm } from '../../components/TraceSearchForm.js';
import { useFlatPages } from '../../hooks/useFlatPages.js';
import { now } from '../../lib/clock.js';
import { traceHref } from '../../lib/hrefs.js';
import styles from './Activity.module.css';
import {
  DEFAULT_RANGE,
  type FilterKey,
  hasFilters,
  idFilterOptions,
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

export function Activity() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  // The moment the time range was chosen: the query's lower bound stays put while live refresh
  // brings in newer events.
  const [anchor, setAnchor] = useState(now);
  const events = useEvents(toActivityQuery(filters, anchor));
  const sources = useSources();
  const processes = useProcesses();
  const destinations = useDestinations();

  const setFilter = (key: FilterKey, value: string) => {
    if (key === 'range') setAnchor(now());
    setParams(withFilter(params, key, value), { replace: true });
  };

  const onArtifact = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('artifact');
    setFilter('artifact', typeof q === 'string' ? q.trim() : '');
  };

  const rows = useFlatPages(events);
  const counts = toneCounts(rows);

  return (
    <>
      <PageHeader
        title="Activity"
        meta={<span className="t-caption">every event and where it stopped</span>}
        actions={
          <TraceSearchForm
            className={styles.traceForm}
            inputClassName={styles.traceInput}
            placeholder="artifact id — what happened to LOL-1712?"
          />
        }
      />

      <div className={styles.filters} role="group" aria-label="Filters">
        <Select
          size="sm"
          aria-label="Source"
          value={filters.source ?? ''}
          placeholder="All sources"
          options={idFilterOptions(sources.data, filters.source)}
          onChange={(e) => {
            setFilter('source', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Process"
          value={filters.process ?? ''}
          placeholder="All processes"
          options={idFilterOptions(processes.data, filters.process)}
          onChange={(e) => {
            setFilter('process', e.target.value);
          }}
        />
        <Select
          size="sm"
          aria-label="Destination"
          value={filters.destination ?? ''}
          placeholder="All destinations"
          options={idFilterOptions(destinations.data, filters.destination)}
          onChange={(e) => {
            setFilter('destination', e.target.value);
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
                <span className={styles.swatch} data-tone={l.tone} aria-hidden="true" />
                {l.label} · <span className="mono">{counts[l.tone]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <QueryBoundary
        query={events}
        errorTitle="Activity could not load"
        pending={
          <Card padding="flush">
            <Skeleton lines={8} height={28} label="Loading activity" />
          </Card>
        }
        isEmpty={() => rows.length === 0}
        empty={
          <Card>
            <EmptyState
              title={hasFilters(filters) ? 'No events match these filters' : 'No events yet'}
            >
              {hasFilters(filters)
                ? 'Widen the time range or clear a filter. Events older than the retention window are gone.'
                : 'Events appear here as soon as a source receives one. Send a test event from a source to see the pipeline work.'}
            </EmptyState>
          </Card>
        }
      >
        {() => (
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
      </QueryBoundary>
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
          <span className={styles.none} title={row.whyNothingRan ?? undefined}>
            {row.whyNothingRan ? `why: ${row.whyNothingRan}` : 'no process'}
          </span>
        ) : (
          <ProcessOutcomes processes={row.processes} />
        )}
      </span>
    </li>
  );
}
