import { useState } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useProcesses } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SearchInput } from '../../components/SearchInput.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { ProcessCard } from './ProcessCard.js';
import styles from './Processes.module.css';
import {
  filterCounts,
  matchesFilter,
  matchesQuery,
  PROCESS_SORTS,
  type ProcessFilter,
  type ProcessSort,
  sortProcesses,
} from './processList.js';

const FILTER_LABELS: Record<ProcessFilter, string> = {
  all: 'All',
  healthy: 'Healthy',
  attention: 'Attention',
  off: 'Off',
};

export function Processes() {
  const processes = useProcesses();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProcessSort>('activity');
  const [filter, setFilter] = useState<ProcessFilter>('all');

  const all = processes.data ?? [];
  const counts = filterCounts(all);
  const shown = sortProcesses(
    all.filter((p) => matchesFilter(p, filter) && matchesQuery(p, query)),
    sort,
  );

  const newButton = (
    <Button
      variant="primary"
      icon="plus"
      requires="operator"
      onClick={() => {
        void navigate('/processes/new');
      }}
    >
      New process
    </Button>
  );

  return (
    <>
      <div className={styles.toolbar}>
        <h1 className="t-screen-title">Processes</h1>
        <SegmentedControl
          label="Status"
          value={filter}
          onChange={setFilter}
          options={(Object.keys(FILTER_LABELS) as ProcessFilter[]).map((f) => ({
            value: f,
            label: FILTER_LABELS[f],
            count: counts[f],
          }))}
        />
        <span className={styles.grow} />
        <SearchInput
          label="Search processes"
          placeholder="name or source"
          mono
          className={styles.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <label className={styles.sort}>
          Sort
          <Select
            size="sm"
            aria-label="Sort"
            value={sort}
            options={PROCESS_SORTS.map((s) => ({ value: s, label: s }))}
            onChange={(e) => {
              setSort(e.target.value as ProcessSort);
            }}
          />
        </label>
        {newButton}
      </div>

      {processes.isError && (
        <Banner tone="error" title="Could not load processes">
          {errorMessage(processes.error)}
        </Banner>
      )}

      {processes.isPending ? (
        <div className={styles.grid} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton
              key={i}
              shape="card"
              height={132}
              label={i === 0 ? 'Loading processes' : undefined}
            />
          ))}
        </div>
      ) : all.length === 0 && !processes.isError ? (
        <Card>
          <EmptyState title="No processes yet" illustration="ghost" actions={newButton}>
            A process connects the events of a source to a destination, under budgets, schedules and
            approvals. Start with one trigger and one destination; you can add sweeps and gates
            later.
          </EmptyState>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title="No processes match" compact>
            Nothing matches “{query}”
            {filter !== 'all' ? ` in ${FILTER_LABELS[filter].toLowerCase()}` : ''}. Try a source
            name or clear the filter.
          </EmptyState>
        </Card>
      ) : (
        <ul className={styles.grid} aria-label="Processes">
          {shown.map((p) => (
            <li key={p.id} className={styles.cell}>
              <ProcessCard process={p} />
            </li>
          ))}
        </ul>
      )}

      {all.length > 0 && (
        <p className="t-caption">
          Dots are the last hour: matched › batched › gated › invoked › ok. The bar is today’s runs
          against the process’s own daily cap; the sparkline is runs over 7 days.
        </p>
      )}
    </>
  );
}
