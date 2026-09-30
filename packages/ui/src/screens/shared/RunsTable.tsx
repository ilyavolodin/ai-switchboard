import type { RunSummary, RunsQuery } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { Link } from 'react-router';

import { useRuns } from '../../api/index.js';
import { ArtifactChips } from '../../components/ArtifactChips.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Drawer } from '../../components/Drawer.js';
import { LoadMore } from '../../components/LoadMore.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { Time } from '../../components/Time.js';
import { useFlatPages } from '../../hooks/useFlatPages.js';
import { formatSeconds } from '../../lib/format.js';
import { processHref } from '../../lib/hrefs.js';
import { RunDrawerBody } from './RunDrawerBody.js';
import { RunExternalLink } from './RunExternalLink.js';
import { runKindText, usageText } from './runsModel.js';
import styles from './RunsTable.module.css';

export type RunsTablePreset = 'process' | 'destination';

export interface RunsTableProps {
  preset: RunsTablePreset;
  filter: Pick<RunsQuery, 'process' | 'destination'>;
  caption: string;
  empty: string;
  /** Usage keys to units, for the destination's usage dimensions. */
  units?: Map<string, string>;
}

function columns(
  preset: RunsTablePreset,
  units: Map<string, string> | undefined,
  onOpen: (id: string) => void,
): TableColumn<RunSummary>[] {
  return [
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <StatusChip
          size="sm"
          tone={r.statusLabel.tone}
          label={r.statusLabel.label}
          title={r.statusReason ?? undefined}
        />
      ),
    },
    ...(preset === 'destination'
      ? [
          {
            key: 'process',
            header: 'Process',
            cell: (r: RunSummary) => <Link to={processHref(r.processId)}>{r.processName}</Link>,
          },
        ]
      : []),
    { key: 'kind', header: 'Kind', cell: runKindText },
    { key: 'invoked', header: 'Invoked', cell: (r) => <Time value={r.invokedAt} /> },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      mono: true,
      cell: (r) => (r.durationSeconds != null ? formatSeconds(r.durationSeconds) : '—'),
    },
    ...(preset === 'destination'
      ? [
          {
            key: 'events',
            header: 'Events',
            align: 'right' as const,
            mono: true,
            cell: (r: RunSummary) => r.eventCount,
          },
        ]
      : [
          {
            key: 'artifacts',
            header: 'Artifacts',
            cell: (r: RunSummary) => (
              <span className={styles.row}>
                <ArtifactChips artifacts={r.artifacts} limit={3} showIcon={false} />
              </span>
            ),
          },
        ]),
    { key: 'usage', header: 'Usage', cell: (r) => usageText(r.usage, units) },
    { key: 'external', header: 'External', cell: (r) => <RunExternalLink run={r} /> },
    {
      key: 'details',
      header: <span className="visually-hidden">Details</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Details for run ${r.id}`}
          onClick={() => {
            onOpen(r.id);
          }}
        >
          Details
        </Button>
      ),
    },
  ];
}

export function RunsTable({ preset, filter, caption, empty, units }: RunsTableProps) {
  const runs = useRuns(filter);
  const rows = useFlatPages(runs);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card padding="flush">
      <QueryBoundary
        query={runs}
        errorTitle="Runs could not load"
        pending={<Skeleton lines={6} height={28} label="Loading runs" />}
      >
        {() => (
          <Table
            caption={caption}
            columns={columns(preset, units, setOpen)}
            rows={rows}
            rowKey={(r) => r.id}
            empty={empty}
          />
        )}
      </QueryBoundary>
      <LoadMore
        hasMore={runs.hasNextPage}
        loading={runs.isFetchingNextPage}
        onLoadMore={() => void runs.fetchNextPage()}
        label="Load more runs"
      />
      <Drawer
        open={open != null}
        onClose={() => {
          setOpen(null);
        }}
        title={open ? `Run ${open}` : 'Run'}
        width={520}
      >
        {open && <RunDrawerBody runId={open} />}
      </Drawer>
    </Card>
  );
}
