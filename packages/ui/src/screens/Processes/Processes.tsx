import { useProcesses } from '../../api/index.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { SearchInput } from '../../components/SearchInput.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { useSearchParamState } from '../../hooks/useSearchParamState.js';
import { ProcessCard } from './ProcessCard.js';
import styles from './Processes.module.css';
import {
  asProcessFilter,
  asProcessSort,
  filterCounts,
  matchesFilter,
  matchesQuery,
  PROCESS_FILTERS,
  PROCESS_SORTS,
  type ProcessFilter,
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
  const [query, setQuery] = useSearchParamState('q');
  const [sortParam, setSort] = useSearchParamState('sort', 'activity');
  const [filterParam, setFilter] = useSearchParamState('filter', 'all');
  const sort = asProcessSort(sortParam);
  const filter = asProcessFilter(filterParam);

  const all = processes.data ?? [];
  const counts = filterCounts(all);

  const newButton = (
    <LinkButton to="/processes/new" variant="primary" icon="plus" requires="operator">
      New process
    </LinkButton>
  );

  return (
    <>
      <div className={styles.toolbar}>
        <h1 className="t-screen-title">Processes</h1>
        <SegmentedControl
          label="Status"
          value={filter}
          onChange={setFilter}
          options={PROCESS_FILTERS.map((f) => ({
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
              setSort(e.target.value);
            }}
          />
        </label>
        {newButton}
      </div>

      <QueryBoundary
        query={processes}
        errorTitle="Processes could not load"
        pending={
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
        }
        empty={
          <Card>
            <EmptyState title="No processes yet" illustration="ghost" actions={newButton}>
              A process connects the events of a source to a destination, under budgets, schedules
              and approvals. Start with one trigger and one destination; you can add sweeps and
              gates later.
            </EmptyState>
          </Card>
        }
      >
        {(list) => {
          const shown = sortProcesses(
            list.filter((p) => matchesFilter(p, filter) && matchesQuery(p, query)),
            sort,
          );
          return (
            <>
              {shown.length === 0 ? (
                <Card>
                  <EmptyState title="No processes match" compact>
                    Nothing matches “{query}”
                    {filter !== 'all' ? ` in ${FILTER_LABELS[filter].toLowerCase()}` : ''}. Try a
                    source name or clear the filter.
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
              <p className="t-caption">
                Dots are the last hour: matched › batched › gated › invoked › ok. The bar is today’s
                runs against the process’s own daily cap; the sparkline is runs over 7 days.
              </p>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
